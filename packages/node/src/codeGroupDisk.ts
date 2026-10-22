import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { EngineError, ExternalStateError, isEngineOwn } from '@abele/sync-core'
import { normalisePath, validatePath } from '@abele/sync-protocol'
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
import { ownTempFolder, realTempFolder } from './nodeFsGuard.js'
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
    let conflicted = false
    for (const step of this.journal.steps.slice(0, this.journal.attempted + 1).reverse()) {
      this.check()
      const before = await matches(this.vault.disk, step.before)
      const after = await matches(this.vault.disk, step.after)
      // Case-only names can resolve to one file with identical bytes/metadata on both sides.
      // Reversing that move is safe even if it never landed, and restores the original spelling.
      if (before && (step.op.kind !== 'move' || !after)) continue
      if (!after) {
        // Preserve the user's edit, but still undo our other members instead of leaving
        // companion files installed merely because the first rollback target changed.
        conflicted = true
        continue
      }
      this.check()
      if (step.op.kind === 'move') {
        if (
          !(await this.vault.disk.conditionalFile({
            path: step.op.to,
            expected: step.after[step.op.to] ?? null,
            effect: { kind: 'move', to: step.op.from },
          }))
        )
          conflicted = true
      } else {
        const image = step.before[step.op.path] ?? null
        if (image === null) {
          if (
            !(await this.vault.disk.conditionalFile({
              path: step.op.path,
              expected: step.after[step.op.path] ?? null,
              effect: { kind: 'remove' },
            }))
          )
            conflicted = true
        } else {
          const bytes = await blobs.read(image)
          this.check()
          if (
            !(await this.vault.disk.conditionalFile({
              path: step.op.path,
              expected: step.after[step.op.path] ?? null,
              effect: { kind: 'write', bytes, mtime: image.mtime },
            }))
          )
            conflicted = true
        }
      }
    }
    if (conflicted)
      throw new EngineError(
        'conflict',
        `code approval recovery found local changes; backups retained in ${this.work}`
      )
  }
  async discard(): Promise<void> {
    this.check()
    this.assertOwningLedger()
    const remove = () => rm(this.work, { recursive: true, force: true })
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
      if (!entry.isDirectory() || !/^group-[a-zA-Z0-9]+$/.test(entry.name)) continue
      const disk = new CodeGroupDisk(join(folder, entry.name), vault, held)
      disk.check()
      const files = new NodeFileSystem(disk.work, {
        effectGuard: () => disk.check(),
        effectTracker: vault.fence?.track,
      })
      if ((await files.stat('journal.json')) !== null) {
        disk.journal = parseJournal(
          JSON.parse(new TextDecoder().decode(await files.read('journal.json'))),
          vault.cfg.vaultId
        )
        disk.assertOwningLedger()
        if (vault.state.getMeta(disk.marker) !== 'committed') await disk.rollback()
      } else if (!(await initialSaveOnly(disk.work))) {
        throw new ExternalStateError('recovery-required', {
          cause: 'unjournaled installation material must be retained',
        })
      }
      await disk.discard()
    }
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
