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
import type { OpenVault } from './vault.js'

const FOLDER = 'code-approvals'
interface Journal {
  version: 1
  vault: string
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
    const folder = await ownTempFolder(resolve(vault.dir), '.abele-sync', FOLDER, check)
    check()
    const work = await mkdtemp(join(folder, 'group-'))
    // The undo journal must remain reachable after a power loss, not only after SIGKILL.
    await syncParents(join(work, 'journal.json'), resolve(vault.dir))
    const group = new CodeGroupDisk(work, vault, held)
    group.check()
    // The directory is fresh. A marker orphaned by earlier cleanup must not bless this group.
    vault.state.setMeta(group.marker, null)
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
    this.journal = { version: 1, vault: this.vault.cfg.vaultId, attempted: -1, steps: draft.steps }
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
      if (op.kind === 'write' && bytes !== null)
        await this.vault.disk.writeAtomic(op.path, bytes, op.image.mtime)
      else if (op.kind === 'remove') await this.vault.disk.remove(op.path)
      else if (op.kind === 'move') await this.vault.disk.move(op.from, op.to)
    }
    this.check()
    if (!(await draft.validateResult()))
      throw new EngineError('conflict', 'code changed during group placement')
    // This is inside the same transaction as ALL ledger changes and the queue removal.
    this.vault.state.setMeta(this.marker, 'committed')
  }
  async rollback(): Promise<void> {
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
        await this.vault.disk.move(step.op.to, step.op.from)
      } else {
        const image = step.before[step.op.path] ?? null
        if (image === null) await this.vault.disk.remove(step.op.path)
        else {
          const bytes = await blobs.read(image)
          this.check()
          await this.vault.disk.writeAtomic(step.op.path, bytes, image.mtime)
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
    const remove = () => rm(this.work, { recursive: true, force: true })
    await (this.vault.fence ? this.vault.fence.track(remove) : remove())
    // Never durably forget the commit marker while the journal's directory could reappear.
    await syncPath(dirname(this.work))
    this.check()
    this.vault.state.setMeta(this.marker, null)
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
        if (vault.state.getMeta(disk.marker) !== 'committed') await disk.rollback()
      } else if ((await readdir(disk.work)).length) {
        throw new ExternalStateError('recovery-required', {
          cause: 'unjournaled installation material must be retained',
        })
      }
      await disk.discard()
    }
  }
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
