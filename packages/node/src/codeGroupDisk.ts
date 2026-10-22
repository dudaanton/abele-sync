import { link, lstat, mkdtemp, readdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { EngineError, ExternalStateError, isEngineOwn } from '@abele/sync-core'
import { caseKey, normalisePath, validatePath } from '@abele/sync-protocol'
import {
  CodeDraft,
  GroupBlobs,
  imageOf,
  sameImage,
  type GroupStep,
  type Images,
} from './codeDraft.js'
import { NodeFileSystem } from './nodeFs.js'
import { syncParents, syncPath } from './nodeFsDurability.js'
import { containedIn, isMissing, ownTempFolder, realTempFolder } from './nodeFsGuard.js'
import type { NodeReplica as OpenVault } from './replica.js'

const FOLDER = 'code-approvals'
interface Journal {
  version: 1
  vault: string
  ledger: string
  attempted: number
  steps: GroupStep[]
}
type Vault = Pick<OpenVault, 'dir' | 'cfg' | 'disk' | 'state' | 'fence'>
export interface CodeGroupReview {
  version: 1
  group: string
  path: string
  reason: 'journal-requires-review'
}
const REVIEW_KEY = 'code-approval-review:'

/** Disk undo journal paired with the enclosing SQLite transaction's commit marker. */
export class CodeGroupDisk {
  private journal: Journal | null = null
  private constructor(
    readonly work: string,
    private readonly vault: Vault,
    private readonly held: () => boolean
  ) {}
  static async create(vault: Vault, held: () => boolean): Promise<CodeGroupDisk> {
    if (!held()) throw new EngineError('lost', 'code approval lost the vault lock')
    const check = () => {
      vault.fence?.assertOwner()
      if (!held()) throw new EngineError('lost', 'code approval lost ownership')
    }
    check()
    // Persist outside the approval transaction: a rollback must not erase ownership.
    const ledger = vault.state.getExternalInstanceId()
    const folder = await ownTempFolder(resolve(vault.dir), '.abele-sync', FOLDER, check)
    check()
    const work = await mkdtemp(join(folder, 'group-'))
    // The undo journal must remain reachable after a power loss, not only after SIGKILL.
    await syncParents(join(work, 'journal.json'), resolve(vault.dir))
    const group = new CodeGroupDisk(work, vault, held)
    group.check()
    // The directory is fresh. A marker orphaned by earlier cleanup must not bless this group.
    vault.state.setMeta(group.marker, null)
    // Give speculative material an owning recovery record before it is allocated.
    // A crash while first publishing the full plan then has a safe empty predecessor.
    group.journal = { version: 1, vault: vault.cfg.vaultId, ledger, attempted: -1, steps: [] }
    await group.save()
    return group
  }
  private get marker(): string {
    return `code-approval:${basename(this.work)}`
  }
  private check(): void {
    this.vault.fence?.assertOwner()
    if (!this.held())
      throw new EngineError(
        'lost',
        'code approval lost the vault lock; recovery is left to its next holder'
      )
  }
  private async save(): Promise<void> {
    this.check()
    await new NodeFileSystem(this.work, {
      effectGuard: () => this.check(),
      effectTracker: this.vault.fence?.track,
    }).writeAtomic('journal.json', new TextEncoder().encode(JSON.stringify(this.journal)), 0)
  }
  async place(draft: CodeDraft): Promise<void> {
    this.check()
    const ledger = this.vault.state.readExternalInstanceId()
    if (ledger === null) throw new ExternalStateError('recovery-required')
    this.journal = {
      version: 1,
      vault: this.vault.cfg.vaultId,
      ledger,
      attempted: -1,
      steps: draft.steps,
    }
    await this.save()
    if (!(await draft.validate()))
      throw new EngineError('conflict', 'code changed before group placement')
    for (const [index, step] of draft.steps.entries()) {
      this.check()
      if (!(await matches(this.vault.disk, step.before)))
        throw new EngineError('conflict', 'code changed immediately before group placement')
      this.journal.attempted = index
      step.spelling = {}
      for (const path of Object.keys(step.before)) step.spelling[path] = await this.actualName(path)
      if (step.op.kind === 'move') {
        const proof = join(this.work, `move-inode-${index}`)
        await link(await containedIn(resolve(this.vault.dir), step.op.from), proof)
        await syncParents(proof, resolve(this.vault.dir))
        const info = await lstat(proof, { bigint: true })
        step.moveIdentity = `${info.dev}:${info.ino}`
      }
      await this.save() // Persist intent before the rename/unlink, including a write that later fails to fsync.
      this.check()
      const op = step.op
      const bytes = op.kind === 'write' ? await draft.blobs.read(op.image) : null
      if (!(await matches(this.vault.disk, step.before)))
        throw new EngineError('conflict', 'code changed before the group write')
      this.check()
      const path = op.kind === 'move' ? op.from : op.path
      const effect =
        op.kind === 'write'
          ? { kind: 'write' as const, bytes: bytes!, mtime: op.image.mtime }
          : op.kind === 'move'
            ? { kind: 'move' as const, to: op.to }
            : { kind: 'remove' as const }
      if (
        !(await this.vault.disk.conditionalFile({
          path,
          expected: step.before[path] ?? null,
          effect,
        }))
      )
        throw new EngineError('conflict', 'code changed at group publication')
    }
    this.check()
    if (!(await draft.validateResult()))
      throw new EngineError('conflict', 'code changed during group placement')
    // This is inside the same transaction as ALL ledger changes and the queue removal.
    this.vault.state.setMeta(this.marker, 'committed')
  }
  async rollback(): Promise<void> {
    this.assertOwningLedger()
    if (this.journal === null || this.vault.state.getMeta(this.marker) === 'committed') return
    const blobs = new GroupBlobs(new NodeFileSystem(join(this.work, 'blobs')))
    for (const step of this.journal.steps.slice(0, this.journal.attempted + 1).reverse()) {
      this.check()
      const before = await matches(this.vault.disk, step.before)
      const after = await matches(this.vault.disk, step.after)
      const op = step.op
      let protect: string | null = null
      if (op.kind === 'move') {
        const source = step.spelling?.[op.from] ?? op.from
        const named = await this.actualName(op.to)
        const proven =
          !!step.moveIdentity &&
          (await this.moveProof(step)) === step.moveIdentity &&
          (await this.identity(op.to)) === step.moveIdentity
        if (!proven && named === op.to) protect = named
        if (before && named !== op.to) {
          await this.restoreBefore(step, blobs)
          continue
        }
        // An edited destination is authoritative only with the identity persisted
        // before publication, and with its real spelling rather than stat aliases.
        if (!after && proven && named === op.to && (await this.actualName(source)) !== source)
          continue
        if (after && proven && named === op.to) {
          if (
            await this.vault.disk.conditionalFile({
              path: op.to,
              expected: step.after[op.to] ?? null,
              effect: { kind: 'move', to: source },
            })
          )
            continue
        }
      } else if (after && !before) {
        // Restore via absence-only publication at the original physical spelling.
        // The backup is durable throughout the gap between removal and restoration.
        await this.vault.disk.conditionalFile({
          path: op.path,
          expected: step.after[op.path] ?? null,
          effect: { kind: 'remove' },
        })
      }
      await this.restoreBefore(step, blobs, protect)
    }
  }

  private async identity(path: string): Promise<string | null> {
    try {
      const info = await lstat(await containedIn(resolve(this.vault.dir), path), { bigint: true })
      return info.isFile() ? `${info.dev}:${info.ino}` : null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  private async moveProof(step: GroupStep): Promise<string | null> {
    try {
      const info = await lstat(join(this.work, `move-inode-${this.journal!.steps.indexOf(step)}`), {
        bigint: true,
      })
      return info.isFile() ? `${info.dev}:${info.ino}` : null
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  private async actualName(path: string): Promise<string | null> {
    const identity = await this.identity(path)
    if (identity === null) return null
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    for (const entry of await this.vault.disk.listChildren(parent)) {
      if (
        entry.kind === 'file' &&
        caseKey(entry.path) === caseKey(path) &&
        (await this.identity(entry.path)) === identity
      )
        return entry.path
    }
    return null
  }

  private async restoreBefore(
    step: GroupStep,
    blobs: GroupBlobs,
    protect: string | null = null
  ): Promise<void> {
    const restored = new Set<string>()
    for (const [key, image] of Object.entries(step.before)) {
      if (image === null) continue
      const path = step.spelling?.[key] ?? key
      if (restored.has(path)) continue
      restored.add(path)
      const current = await imageOf(this.vault.disk, path)
      if (sameImage(current, image) && (await this.actualName(path)) !== protect) {
        const name = await this.actualName(path)
        if (name === path) continue
        if (
          name &&
          (await this.vault.disk.conditionalFile({
            path: name,
            expected: image,
            effect: { kind: 'move', to: path },
          }))
        )
          continue
      }
      const bytes = await blobs.read(image)
      for (let n = 0; ; n++) {
        const target =
          n === 0
            ? path
            : `${path}.sync-conflict-${basename(this.work)}-${image.sha.slice(0, 12)}${n > 1 ? `-${n}` : ''}`
        const have = await imageOf(this.vault.disk, target)
        if (
          have?.sha === image.sha &&
          have.size === image.size &&
          (await this.actualName(target)) !== protect
        )
          break
        if (have !== null) continue
        this.check()
        if (
          await this.vault.disk.conditionalFile({
            path: target,
            expected: null,
            effect: { kind: 'write', bytes, mtime: image.mtime },
          })
        )
          break
      }
    }
  }
  async discard(): Promise<void> {
    this.check()
    this.assertOwningLedger()
    const remove = async () => {
      const trash = join(dirname(this.work), `trash-${basename(this.work)}-${randomUUID()}`)
      // Never expose a partly removed group as an active recovery journal.
      await rename(this.work, trash)
      await syncPath(dirname(this.work))
      this.check()
      this.vault.state.setMeta(this.marker, null)
      await rm(trash, { recursive: true, force: true })
    }
    await (this.vault.fence ? this.vault.fence.track(remove) : remove())
    // Never durably forget the commit marker while the journal's directory could reappear.
    await syncPath(dirname(this.work))
    this.check()
    this.vault.state.setMeta(this.marker, null)
  }

  private assertOwningLedger(): void {
    if (
      this.journal !== null &&
      (typeof this.journal.ledger !== 'string' ||
        this.journal.ledger !== this.vault.state.readExternalInstanceId())
    )
      throw new ExternalStateError('recovery-required', {
        cause: 'code approval requires its owning ledger; recovery files left untouched',
      })
  }

  /** Called only while owning the vault, before a new sync or approval can see a partial group. */
  static async recover(vault: Vault, held: () => boolean): Promise<void> {
    const folder = realTempFolder(resolve(vault.dir), '.abele-sync', FOLDER)
    if (folder === null) return
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const review = /^review-(group-[a-zA-Z0-9]+)-[a-f0-9-]{36}$/.exec(entry.name)
      if (entry.isDirectory() && review) {
        await CodeGroupDisk.recordReview(vault, held, entry.name, review[1]!)
        continue
      }
      const trash = /^trash-(group-[a-zA-Z0-9]+)-[a-f0-9-]{36}$/.exec(entry.name)
      if (entry.isDirectory() && trash) {
        const remove = async () => {
          vault.fence?.assertOwner()
          if (!held()) throw new EngineError('lost', 'code cleanup lost ownership')
          await syncPath(folder)
          vault.state.setMeta(`code-approval:${trash[1]}`, null)
          await rm(join(folder, entry.name), { recursive: true, force: true })
          await syncPath(folder)
        }
        await (vault.fence ? vault.fence.track(remove) : remove())
        continue
      }
      if (!entry.isDirectory() || !/^group-[a-zA-Z0-9]+$/.test(entry.name)) continue
      const disk = new CodeGroupDisk(join(folder, entry.name), vault, held)
      disk.check()
      const files = new NodeFileSystem(disk.work, {
        effectGuard: () => disk.check(),
        effectTracker: vault.fence?.track,
      })
      if ((await files.stat('journal.json')) !== null) {
        // Read failures remain I/O errors; malformed/foreign metadata is retained
        // for review and must not poison all future starts.
        const raw = await files.read('journal.json')
        try {
          disk.journal = parseJournal(JSON.parse(new TextDecoder().decode(raw)), vault.cfg.vaultId)
          disk.assertOwningLedger()
        } catch {
          await disk.retainForReview()
          continue
        }
        if (vault.state.getMeta(disk.marker) !== 'committed') await disk.rollback()
      } else if (!(await initialSaveOnly(disk.work))) {
        await disk.retainForReview()
        continue
      }
      await disk.discard()
    }
  }

  static reviews(vault: Pick<OpenVault, 'state'>): CodeGroupReview[] {
    return vault.state
      .metadataKeys(REVIEW_KEY)
      .map((key) => JSON.parse(vault.state.getMeta(key)!) as CodeGroupReview)
  }

  private async retainForReview(): Promise<void> {
    const retain = async () => {
      this.check()
      const name = `review-${basename(this.work)}-${randomUUID()}`
      await rename(this.work, join(dirname(this.work), name))
      await CodeGroupDisk.recordReview(this.vault, this.held, name, basename(this.work))
    }
    await (this.vault.fence ? this.vault.fence.track(retain) : retain())
  }

  private static async recordReview(
    vault: Vault,
    held: () => boolean,
    name: string,
    group: string
  ): Promise<void> {
    vault.fence?.assertOwner()
    if (!held()) throw new EngineError('lost', 'review recovery lost ownership')
    // The rename is the durable classification. Reconstruct the same single record
    // after a crash before its metadata write; never reparse or remove the backup.
    await syncPath(join(resolve(vault.dir), '.abele-sync', FOLDER))
    vault.fence?.assertOwner()
    if (!held()) throw new EngineError('lost', 'review recovery lost ownership')
    const record: CodeGroupReview = {
      version: 1,
      group,
      path: `.abele-sync/${FOLDER}/${name}`,
      reason: 'journal-requires-review',
    }
    const key = REVIEW_KEY + name
    if (vault.state.getMeta(key) === null) vault.state.setMeta(key, JSON.stringify(record))
  }
}

/** Before the first journal is published, only its private temp ancestry can exist.
 * Never classify draft blobs, symlinks or unknown material as disposable. */
async function initialSaveOnly(work: string): Promise<boolean> {
  async function only(folder: string, child?: string): Promise<boolean> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (child === undefined) {
        if (!entry.isFile() || !/^[a-f0-9]{24}$/.test(entry.name)) return false
      } else {
        if (entry.name !== child || !entry.isDirectory()) return false
        if (!(await only(join(folder, child), child === '.abele-sync' ? 'tmp' : undefined)))
          return false
      }
    }
    return true
  }
  return only(work, '.abele-sync')
}

async function matches(fs: NodeFileSystem, images: Images): Promise<boolean> {
  for (const [path, image] of Object.entries(images)) {
    if (!sameImage(image, await imageOf(fs, path))) return false
  }
  return true
}

/** Recovery metadata is local, but never use a malformed path or cache reference as authority. */
function parseJournal(value: unknown, vault: string): Journal {
  const fail = (): never => {
    throw new EngineError(
      'conflict',
      'unreadable code approval journal; recovery files left untouched'
    )
  }
  if (value === null || typeof value !== 'object') return fail()
  const raw = value as Partial<Journal>
  if (
    raw.version !== 1 ||
    raw.vault !== vault ||
    !Array.isArray(raw.steps) ||
    !Number.isInteger(raw.attempted) ||
    raw.attempted! < -1 ||
    raw.attempted! >= raw.steps.length
  )
    return fail()
  const path = (p: unknown): void => {
    if (typeof p !== 'string' || isEngineOwn(p)) return fail()
    validatePath(normalisePath(p))
    if (p.startsWith('/') || p.includes('\\')) return fail()
  }
  const image = (v: unknown): void => {
    if (v === null) return
    if (typeof v !== 'object') return fail()
    const i = v as { sha?: unknown; size?: unknown; mtime?: unknown }
    if (
      typeof i.sha !== 'string' ||
      !/^[a-f0-9]{64}$/.test(i.sha) ||
      typeof i.size !== 'number' ||
      !Number.isSafeInteger(i.size) ||
      i.size < 0 ||
      typeof i.mtime !== 'number' ||
      !Number.isFinite(i.mtime) ||
      i.mtime < 0
    )
      return fail()
  }
  for (const step of raw.steps) {
    if (step === null || typeof step !== 'object' || !step.op || typeof step.op !== 'object')
      return fail()
    const op = step.op
    if (
      step.moveIdentity !== undefined &&
      (typeof step.moveIdentity !== 'string' || !/^\d+:\d+$/.test(step.moveIdentity))
    )
      return fail()
    if (step.spelling !== undefined) {
      if (step.spelling === null || typeof step.spelling !== 'object') return fail()
      const keys = op.kind === 'move' ? [op.from, op.to] : [op.path]
      if (
        JSON.stringify(Object.keys(step.spelling).sort()) !==
        JSON.stringify([...new Set(keys)].sort())
      )
        return fail()
      for (const [key, value] of Object.entries(step.spelling)) {
        if (value !== null) {
          path(value)
          if (caseKey(key) !== caseKey(value)) return fail()
        }
      }
    }
    if (op.kind === 'move') {
      path(op.from)
      path(op.to)
    } else if (op.kind === 'write') {
      path(op.path)
      image(op.image)
      if (op.image === null) return fail()
    } else if (op.kind === 'remove') path(op.path)
    else return fail()
    const keys = [...new Set(op.kind === 'move' ? [op.from, op.to] : [op.path])].sort()
    for (const images of [step.before, step.after]) {
      if (
        images === null ||
        typeof images !== 'object' ||
        JSON.stringify(Object.keys(images).sort()) !== JSON.stringify(keys)
      )
        return fail()
      for (const value of Object.values(images)) image(value)
    }
  }
  return raw as Journal
}
