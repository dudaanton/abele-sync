import type { ChangeItem } from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import type { StateEntry, StateStore } from './state.js'
import { replayAuthority } from './replayAuthority.js'
import { pathOccupant } from './pathOccupant.js'
import type { FileSystem } from './fs.js'
import { discardPullStage } from './pullStages.js'
import { DEFERRED_KEY, parse, type Filed } from './deferredFile.js'
import { commitAppliedSettlement } from './settlement.js'
import { afterStateCommit } from './stateTransaction.js'
import { pathRefusal } from './placementRefusal.js'
import type { EngineClient } from './engineClient.js'
import { hasStoredDirectoryRefusals } from './v2Directories.js'

/** Intent saved before a pull touches the disk, retired atomically with its ledger update. */
interface PendingPullWrite {
  sourceIdentity?: string
  heldOrder?: number
  retiring?: boolean
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

type Decision = Pick<ChangeItem, 'file_id' | 'version_id'>
export interface DecisionRetirement {
  held: Decision[]
}

/** A store without durable metadata cannot prove a previous process's write; never infer it. */
export class PendingPullWrites {
  private decisionIndex?: { image: string | null; versions: Set<string> }
  constructor(
    private readonly state: StateStore,
    private readonly fs?: FileSystem,
    private readonly sequenceKnown = true,
    private readonly client: Pick<EngineClient, 'pathRefusal'> = {}
  ) {}

  /** Include durable intent names even when the caller no longer has its old base. */
  async refused(
    fileId: string,
    extra: Array<string | null | undefined> = [],
    base?: StateEntry | null
  ) {
    // Most runs have no directory refusals. Revalidate that durable image once
    // per boundary before loading intent/ledger/decision names unnecessarily.
    if (!this.client.pathRefusal && !(await hasStoredDirectoryRefusals(this.state))) return
    const pending = await this.read(fileId)
    const current = await this.state.byFileId(fileId)
    const paths = [
      ...extra,
      base?.path,
      base?.wirePath,
      current?.path,
      current?.wirePath,
      pending?.wirePath,
      pending?.target,
      pending?.from,
      pending?.base?.path,
      pending?.base?.wirePath,
    ]
    {
      const filed = parse((await this.state.getMeta?.(DEFERRED_KEY)) ?? null)
      for (const item of filed.staged)
        if (item.change.file_id === fileId) paths.push(item.change.path, item.change.prev_path)
    }
    return pathRefusal(
      this.client,
      this.state,
      new Set(paths.filter((path): path is string => path != null))
    )
  }

  async prepare(
    change: ChangeItem,
    base: StateEntry | null,
    target: string,
    from: string | null,
    stageId?: string,
    receiptId?: string,
    sourceIdentity?: string
  ): Promise<void> {
    if (await this.refused(change.file_id, [change.path, change.prev_path, target, from], base))
      return
    if (this.state.getMeta === undefined || this.state.setMeta === undefined) return
    const owner = this.state.effectOwner?.()
    const pending: PendingPullWrite = {
      ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
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
    if (await this.refused(change.file_id, [change.path, change.prev_path])) return
    const pending = await this.read(change.file_id)
    if (pending?.versionId === change.version_id) {
      if (pending.stageId !== undefined && discard) await discard(pending.stageId)
      await this.clear(change.file_id)
    }
  }

  async clear(fileId: string): Promise<void> {
    if (await this.refused(fileId)) return
    await this.state.setMeta?.(keyFor(fileId), null)
  }

  /** Private byte cleanup (also used by cache eviction, which keeps its decision).
   * Retire bytes before their ownership record. An interrupted retirement is
   * resumed, never interpreted as permission to install or fetch the old stage. */
  private async retire(pending: PendingPullWrite): Promise<void> {
    if (await this.refused(pending.fileId)) return
    if (!this.fs)
      throw new EngineError('io', 'host cannot retire a held pull stage without its filesystem')
    const original = JSON.stringify(pending)
    const retiring = JSON.stringify({ ...pending, retiring: true })
    let owned = false
    await commitAppliedSettlement(
      this.state,
      async () => ({ reached: await this.state.getCursor(), firstUnresolved: null }),
      async (tx) => {
        const current = new PendingPullWrites(tx, this.fs, this.sequenceKnown, this.client)
        if (
          JSON.stringify(await current.read(pending.fileId)) !== original ||
          (await current.refused(pending.fileId))
        )
          return
        await tx.setMeta?.(keyFor(pending.fileId), retiring)
        // A caller may itself be inside a raw host transaction. Its rollback
        // must not lose private bytes; recovery finishes cleanup after commit.
        afterStateCommit(tx, () => {
          owned = true
        })
      }
    )
    if (!owned) return
    if (pending.stageId) await discardPullStage(this.fs, pending.stageId)
    if (pending.receiptId) await this.fs.discardInstallation?.(pending.receiptId)
    await commitAppliedSettlement(
      this.state,
      async () => ({ reached: await this.state.getCursor(), firstUnresolved: null }),
      async (tx) => {
        const current = new PendingPullWrites(tx, this.fs, this.sequenceKnown, this.client)
        if (
          JSON.stringify(await current.read(pending.fileId)) !== retiring ||
          (await current.refused(pending.fileId))
        )
          return
        await tx.setMeta?.(keyFor(pending.fileId), null)
      }
    )
  }

  async superseded(change: ChangeItem): Promise<void> {
    if (await this.refused(change.file_id, [change.path, change.prev_path])) return
    const pending = await this.read(change.file_id)
    if (!pending) return
    const newer =
      pending.versionId !== change.version_id &&
      pending.seq !== undefined &&
      change.seq > pending.seq
    if (pending.retiring) await this.retire(pending)
    else if (newer)
      await this.retireDecision({ file_id: pending.fileId, version_id: pending.versionId })
  }

  /** Only the atomic owner transition may publish a retirement marker. */
  private async prepareRetirement(
    change: Pick<ChangeItem, 'file_id' | 'version_id'>
  ): Promise<void> {
    if (await this.refused(change.file_id))
      throw new EngineError('conflict', `decision retirement held: ${change.file_id}`)
    const pending = await this.read(change.file_id)
    if (pending?.versionId !== change.version_id) return
    if (!this.fs)
      throw new EngineError('io', 'host cannot retire a held pull stage without its filesystem')
    if (!pending.retiring)
      await this.state.setMeta!(
        keyFor(pending.fileId),
        JSON.stringify({ ...pending, retiring: true })
      )
  }

  /** One publication path for exclusion, deferred drop/replacement and newer
   * heads. Revoke exact versions (or publish their replacement document) with
   * every retirement marker, then finish byte cleanup outside the transaction. */
  async retireDecisions(
    changes: readonly Pick<ChangeItem, 'file_id' | 'version_id'>[],
    replacement?: Filed,
    replacementRevision?: string | null
  ): Promise<DecisionRetirement> {
    const result: DecisionRetirement = { held: [] }
    if (!this.state.getMeta || !this.state.setMeta) return result
    const identity = (change: Pick<ChangeItem, 'file_id' | 'version_id'>) =>
      JSON.stringify([change.file_id, change.version_id])
    const kept = new Set(replacement?.staged.map((one) => identity(one.change)))
    const ended: Decision[] = []
    for (const change of changes.filter((change) => !kept.has(identity(change)))) {
      if (await this.refused(change.file_id)) result.held.push(change)
      else ended.push(change)
    }
    if (!replacement && !ended.length) return result
    await commitAppliedSettlement(
      this.state,
      async () => ({ reached: await this.state.getCursor(), firstUnresolved: null }),
      async (tx) => {
        if (
          replacementRevision !== undefined &&
          (await tx.getMeta!(DEFERRED_KEY)) !== replacementRevision
        )
          throw new EngineError('conflict', 'deferred decision revision changed')
        const pending = new PendingPullWrites(tx, this.fs, this.sequenceKnown, this.client)
        for (const change of ended) await pending.prepareRetirement(change)
        const filed = parse(await tx.getMeta!(DEFERRED_KEY))
        const gone = new Set(ended.map(identity))
        let staged =
          replacement?.staged ?? filed.staged.filter((one) => !gone.has(identity(one.change)))
        if (replacement && result.held.length) {
          const blocked = new Set(result.held.map((one) => one.file_id))
          const previous = new Map(filed.staged.map((one) => [one.change.file_id, one]))
          staged = staged.map((one) =>
            blocked.has(one.change.file_id) ? (previous.get(one.change.file_id) ?? one) : one
          )
          const present = new Set(staged.map((one) => one.change.file_id))
          for (const one of filed.staged)
            if (blocked.has(one.change.file_id) && !present.has(one.change.file_id))
              staged.push(one)
        }
        if (replacement || staged.length !== filed.staged.length)
          await tx.setMeta!(DEFERRED_KEY, staged.length ? JSON.stringify({ staged }) : null)
      }
    )
    for (const change of ended) await this.finishRetirement(change)
    return result
  }

  /** Pull can end a decision before staging.tidy; skip absent owners without
   * creating an empty transaction for every ordinary excluded feed item. */
  async retireDecision(
    change: Pick<ChangeItem, 'file_id' | 'version_id'>
  ): Promise<DecisionRetirement> {
    if (await this.refused(change.file_id)) return { held: [change] }
    if (!this.state.getMeta || !this.state.setMeta) return { held: [] }
    const pending = await this.read(change.file_id)
    if (pending?.versionId !== change.version_id) {
      const image = await this.state.getMeta(DEFERRED_KEY)
      if (this.decisionIndex?.image !== image)
        this.decisionIndex = {
          image,
          versions: new Set(
            parse(image).staged.map((one) =>
              JSON.stringify([one.change.file_id, one.change.version_id])
            )
          ),
        }
      if (!this.decisionIndex.versions.has(JSON.stringify([change.file_id, change.version_id])))
        return { held: [] }
    }
    return this.retireDecisions([change])
  }

  /** Cleanup may only finish a retirement whose atomic publication already landed. */
  async finishRetirement(change: Pick<ChangeItem, 'file_id' | 'version_id'>): Promise<void> {
    if (await this.refused(change.file_id)) return
    const pending = await this.read(change.file_id)
    if (pending?.versionId === change.version_id && pending.retiring) await this.retire(pending)
  }

  async retain(
    fileId: string,
    limits?: { count: number; bytes: number },
    log?: (message: string) => void
  ): Promise<boolean> {
    if (await this.refused(fileId)) return true
    const pending = await this.read(fileId)
    if (!pending?.stageId) return false
    const held: PendingPullWrite[] = []
    // Enumeration is required to bound retention across process restarts.
    if (!this.state.metadataKeys) {
      log?.(`pull: evicting held stage ${pending.wirePath}: host cannot enumerate owned stages`)
      await this.retire(pending)
      return true
    }
    for (const key of await this.state.metadataKeys('pull-write:')) {
      const saved = await this.read(key.slice('pull-write:'.length))
      if (saved?.retiring) await this.retire(saved)
      else if (saved?.heldOrder !== undefined && saved.fileId !== fileId) held.push(saved)
    }
    pending.heldOrder ??= 1 + Math.max(0, ...held.map((saved) => saved.heldOrder!))
    await this.state.setMeta?.(keyFor(fileId), JSON.stringify(pending))
    held.push(pending)
    held.sort((a, b) => a.heldOrder! - b.heldOrder! || a.fileId.localeCompare(b.fileId))
    const bounded = (value: number | undefined, fallback: number) =>
      value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : fallback
    const count = bounded(limits?.count, 64)
    const cap = bounded(limits?.bytes, 256 * 1024 * 1024)
    let bytes = held.reduce((sum, saved) => sum + (saved.size ?? 0), 0)
    while (held.length > count || bytes > cap) {
      const oldest = held.shift()!
      log?.(
        `pull: evicting held stage ${oldest.wirePath} (${oldest.size ?? 0} bytes): retained stage limit`
      )
      await this.retire(oldest)
      bytes -= oldest.size ?? 0
    }
    return true
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
