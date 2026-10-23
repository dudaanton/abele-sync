import type { ChangeItem } from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import type { StateEntry, StateStore } from './state.js'
import { replayAuthority } from './replayAuthority.js'
import { pathOccupant } from './pathOccupant.js'
import type { FileSystem } from './fs.js'

/** Intent saved before a pull touches the disk, retired atomically with its ledger update. */
interface PendingPullWrite {
  seq?: number
  receiptId?: string
  stageId?: string
  owner?: string
  fileId: string
  versionId: string
  wirePath: string
  sha: string | null
  size: number | null
  mtime: number | null
  target: string
  from: string | null
  base: StateEntry | null
}

const keyFor = (fileId: string): string => `pull-write:${fileId}`
const ENTRY_FIELDS = ['path', 'wirePath', 'fileId', 'versionId', 'sha', 'size', 'mtime'] as const
const sameEntry = (a: StateEntry | null, b: StateEntry | null): boolean =>
  a === null || b === null ? a === b : ENTRY_FIELDS.every((key) => a[key] === b[key])

/** A store without durable metadata cannot prove a previous process's write; never infer it. */
export class PendingPullWrites {
  constructor(
    private readonly state: StateStore,
    private readonly fs?: FileSystem,
    private readonly sequenceKnown = true
  ) {}

  async prepare(
    change: ChangeItem,
    base: StateEntry | null,
    target: string,
    from: string | null,
    stageId?: string,
    receiptId?: string
  ): Promise<void> {
    if (this.state.getMeta === undefined || this.state.setMeta === undefined) return
    const owner = this.state.effectOwner?.()
    const pending: PendingPullWrite = {
      ...(this.sequenceKnown ? { seq: change.seq } : {}),
      ...(receiptId === undefined ? {} : { receiptId }),
      ...(stageId === undefined ? {} : { stageId }),
      ...(owner === undefined ? {} : { owner }),
      fileId: change.file_id,
      versionId: change.version_id,
      wirePath: change.path,
      sha: change.sha,
      size: change.size,
      mtime: change.mtime,
      target,
      from,
      base,
    }
    await this.state.setMeta(keyFor(change.file_id), JSON.stringify(pending))
  }

  async matching(change: ChangeItem, base: StateEntry | null): Promise<PendingPullWrite | null> {
    const pending = await this.read(change.file_id)
    if (
      pending === null ||
      pending.versionId !== change.version_id ||
      pending.wirePath !== change.path ||
      pending.sha !== change.sha ||
      pending.size !== change.size ||
      pending.mtime !== change.mtime ||
      !sameEntry(pending.base, base)
    )
      return null
    return pending
  }

  /** A saved action must not become fresh work merely because its base no longer
   * matches. Check every adoption/placement path, and again inside publication. */
  async authorizes(change: ChangeItem, base: StateEntry | null, target: string): Promise<boolean> {
    const saved = await this.read(change.file_id)
    if (saved === null || saved.versionId !== change.version_id) return true
    const current = await this.state.byFileId(change.file_id)
    return (
      saved.target === target &&
      sameEntry(base, current) &&
      (await this.matching(change, current)) !== null &&
      replayAuthority(
        change.file_id,
        saved.base,
        current,
        await pathOccupant(this.fs, this.state, target, change.file_id)
      )
    )
  }

  /** A replay whose ledger already landed needs no recovery, but must retire its own intent. */
  async stageId(change: ChangeItem): Promise<string | undefined> {
    const pending = await this.read(change.file_id)
    return pending?.versionId === change.version_id ? pending.stageId : undefined
  }
  async receiptId(change: ChangeItem): Promise<string | undefined> {
    const pending = await this.read(change.file_id)
    return pending?.versionId === change.version_id ? pending.receiptId : undefined
  }
  async settled(change: ChangeItem, discard?: (id: string) => Promise<void>): Promise<void> {
    const pending = await this.read(change.file_id)
    if (pending?.versionId === change.version_id) {
      if (pending.stageId !== undefined && discard) await discard(pending.stageId)
      await this.clear(change.file_id)
    }
  }

  async clear(fileId: string): Promise<void> {
    await this.state.setMeta?.(keyFor(fileId), null)
  }

  private async read(fileId: string): Promise<PendingPullWrite | null> {
    if (this.state.getMeta === undefined || this.state.setMeta === undefined) return null
    const raw = await this.state.getMeta(keyFor(fileId))
    if (raw === null) return null
    try {
      const pending = JSON.parse(raw) as PendingPullWrite
      if (
        pending === null ||
        pending.fileId !== fileId ||
        typeof pending.versionId !== 'string' ||
        typeof pending.target !== 'string' ||
        typeof pending.wirePath !== 'string' ||
        !(pending.from === null || typeof pending.from === 'string') ||
        !(pending.base === null || (typeof pending.base === 'object' && pending.base !== undefined))
      ) {
        throw new Error('invalid pending pull write')
      }
      return pending
    } catch (cause) {
      throw new EngineError('io', 'cannot read pending pull write', cause)
    }
  }
}
