import type { ChangeItem } from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import type { StateEntry, StateStore } from './state.js'

/** Intent saved before a pull touches the disk, retired atomically with its ledger update. */
interface PendingPullWrite {
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
  constructor(private readonly state: StateStore) {}

  async prepare(
    change: ChangeItem,
    base: StateEntry | null,
    target: string,
    from: string | null
  ): Promise<void> {
    if (this.state.getMeta === undefined || this.state.setMeta === undefined) return
    const owner = this.state.effectOwner?.()
    const pending: PendingPullWrite = {
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

  /** A replay whose ledger already landed needs no recovery, but must retire its own intent. */
  async settled(change: ChangeItem): Promise<void> {
    if ((await this.read(change.file_id))?.versionId === change.version_id) {
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
