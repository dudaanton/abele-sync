import { normalisePath, validatePath, type ChangeItem } from '@abele/sync-protocol'
import { ExpectedWrites } from './echo.js'
import { ExternalStateError } from './external/state.js'
import { sha256 } from './hash.js'
import type { FileSystem } from './fs.js'
import type { EngineClient } from './engineClient.js'
import { PullPlacer } from './pullPlace.js'
import type { StateEntry, StateStore } from './state.js'
import { checkCancellation } from './cancellation.js'
import { discardPullStage, stageMissing } from './pullStages.js'
import { isFileFailure, type FileRetries } from './fileRetry.js'
import { PendingPullWrites } from './pullWrite.js'

interface Intent {
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
/** Read the existing normal-pull intent, never synthesize one from matching content. */
export function decodePullIntent(raw: string, fileId: string): Intent {
  try {
    const value = JSON.parse(raw) as Intent
    if (
      value?.sourceIdentity !== undefined &&
      (typeof value.sourceIdentity !== 'string' ||
        !value.sourceIdentity ||
        value.sourceIdentity.length > 256)
    )
      throw new Error('invalid source identity')
    if (
      value?.heldOrder !== undefined &&
      (!Number.isSafeInteger(value.heldOrder) || value.heldOrder < 1)
    )
      throw new Error('invalid held stage order')
    if (value?.retiring !== undefined && typeof value.retiring !== 'boolean')
      throw new Error('invalid stage retirement')
    if (value?.seq !== undefined && (!Number.isSafeInteger(value.seq) || value.seq < 0))
      throw new Error('invalid feed sequence')
    if (
      value?.stageId !== undefined &&
      (typeof value.stageId !== 'string' ||
        value.stageId.length === 0 ||
        value.stageId.length > 128)
    )
      throw new Error('invalid stage id')
    if (
      value?.owner !== undefined &&
      (typeof value.owner !== 'string' || !value.owner || value.owner.length > 128)
    )
      throw new Error('invalid intent owner')
    if (
      !value ||
      value.fileId !== fileId ||
      typeof value.versionId !== 'string' ||
      !value.versionId ||
      typeof value.target !== 'string' ||
      typeof value.wirePath !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha ?? '') ||
      !Number.isSafeInteger(value.size) ||
      (value.size as number) < 0 ||
      !Number.isSafeInteger(value.mtime) ||
      (value.mtime as number) < 0 ||
      !(value.from === null || typeof value.from === 'string') ||
      !(value.base === null || typeof value.base === 'object')
    )
      throw new Error('invalid intent')
    validatePath(value.wirePath)
    validatePath(normalisePath(value.target))
    if (value.from !== null) validatePath(normalisePath(value.from))
    if (
      value.base !== null &&
      (value.base.fileId !== fileId ||
        typeof value.base.path !== 'string' ||
        typeof value.base.wirePath !== 'string' ||
        typeof value.base.versionId !== 'string' ||
        !value.base.versionId ||
        !/^[a-f0-9]{64}$/.test(value.base.sha) ||
        !Number.isSafeInteger(value.base.size) ||
        value.base.size < 0 ||
        !Number.isSafeInteger(value.base.mtime) ||
        value.base.mtime < 0)
    )
      throw new Error('invalid base')
    if (value.base) {
      validatePath(value.base.wirePath)
      validatePath(normalisePath(value.base.path))
    }
    return value
  } catch (cause) {
    throw new ExternalStateError('recovery-required', { cause })
  }
}
/** Legacy intents use metadata-only recovery. Stage intents resume their authorized
 * immutable version before ordinary scanning, using the supplied streaming client.
 * Legacy recovery never installs,
 * overwrites, renames or removes a file. The established PullPlacer provenance check
 * requires this exact intent AND its still-current pre-write ledger base.
 */
export async function recoverPendingPullWrites(
  fs: FileSystem,
  state: StateStore,
  fileIds: readonly string[],
  client?: Pick<EngineClient, 'getBlob' | 'openVersion' | 'pathRefusal'>,
  opts: {
    signal?: AbortSignal
    expected?: ExpectedWrites
    retries?: FileRetries
    log?: (message: string) => void
  } = {}
): Promise<{ held: ChangeItem[] }> {
  const report: { held: ChangeItem[] } = { held: [] }
  const cleanup = new PendingPullWrites(state, fs, true, client, opts.signal)
  await cleanup.recoverCleanup()
  checkCancellation(opts.signal)
  await cleanup.flushCleanup()
  const placerFor = (sequenceKnown: boolean) =>
    new PullPlacer(
      client ?? {
        getBlob: async () => {
          throw new ExternalStateError('recovery-required')
        },
      },
      fs,
      state,
      {
        signal: opts.signal,
        expected: opts.expected ?? new ExpectedWrites(),
        dirty: new Set(),
        filter: { excluded: () => false },
        log: opts.log,
      },
      sha256,
      sequenceKnown
    )
  for (const fileId of fileIds) {
    checkCancellation(opts.signal)
    const raw = await state.getMeta?.(`pull-write:${fileId}`)
    if (raw == null) continue
    let path = `pull-write:${fileId}`
    if (opts.retries && !opts.retries.ready(path)) continue
    // A broken record may have displaced its original name. Keep that ledger
    // base protected as well as the destination until recovery settles.
    const entry = await state.byFileId(fileId)
    const protectedPaths = new Set(entry ? [entry.wirePath] : [])
    try {
      const intent = decodePullIntent(raw, fileId)
      const placer = placerFor(intent.seq !== undefined)
      path = intent.wirePath
      protectedPaths.add(path)
      if (opts.retries && !opts.retries.ready(path)) continue
      const change: ChangeItem = {
        seq: intent.seq ?? 1,
        file_id: fileId,
        version_id: intent.versionId,
        path: intent.wirePath,
        op: intent.from === null ? 'modify' : 'move',
        prev_path: intent.from,
        sha: intent.sha,
        size: intent.size,
        mtime: intent.mtime,
        kind: 'attachment',
        actor: { kind: 'system', id: 'recovery', name: 'recovery' },
        at: '',
      }
      if (await placer.refusal(change, entry)) {
        report.held.push(change)
        continue
      }
      if (intent.retiring) {
        await placer.pending.recoverRetirement(fileId, raw)
        continue
      }
      await placer.pending.superseded(change)
      if (
        entry?.versionId === intent.versionId &&
        entry.wirePath === intent.wirePath &&
        entry.path === intent.target &&
        entry.sha === intent.sha &&
        entry.size === intent.size
      ) {
        await placer.settled(change)
        await opts.retries?.succeeded(path, 'recovery')
        await opts.retries?.succeeded(`pull-write:${fileId}`, 'recovery')
        for (const name of protectedPaths) await opts.retries?.succeeded(name, 'recovery')
        continue
      }
      // Installation may have committed the ledger before retiring a formerly
      // held stage. Only unresolved refusals remain available to scan/push.
      if (intent.heldOrder !== undefined) {
        report.held.push(change)
        await placer.pending.retain(fileId, undefined, opts.log)
        for (const name of [...protectedPaths, `pull-write:${fileId}`])
          await opts.retries?.succeeded(name, 'recovery')
        continue
      }
      if ((await placer.pending.matching(change, entry)) === null)
        throw new ExternalStateError('recovery-required')
      await placer.adopt(change, entry)
      // Adoption may have settled the ledger and discarded the stage. Retire
      // its acknowledged alias before deciding whether installation needs replay.
      await placer.pending.flushCleanup()
      if (
        (intent.stageId !== undefined || (intent.from !== null && client !== undefined)) &&
        (await state.getMeta?.(`pull-write:${fileId}`)) != null
      ) {
        if (intent.stageId !== undefined && (!client?.openVersion || !fs.reopenStage))
          throw new ExternalStateError('recovery-required')
        try {
          await placer.place(change, intent.sha!, entry, new Map(), new Map())
        } catch (error) {
          if (!stageMissing(error) || intent.stageId === undefined) throw error
          await discardPullStage(fs, intent.stageId)
          await placer.pending.clear(fileId)
        }
      }
      // adopt either recorded the completed installation or preserved both local bytes
      // and the earlier base, retiring only a definite not-written intent.
      await placer.pending.flushCleanup()
      const remaining = await state.getMeta?.(`pull-write:${fileId}`)
      if (remaining != null && decodePullIntent(remaining, fileId).heldOrder === undefined)
        throw new ExternalStateError('recovery-required')
      await opts.retries?.succeeded(path, 'recovery')
      await opts.retries?.succeeded(`pull-write:${fileId}`, 'recovery')
      for (const name of protectedPaths) await opts.retries?.succeeded(name, 'recovery')
    } catch (error) {
      checkCancellation(opts.signal)
      if (!opts.retries || !(isFileFailure(error) || error instanceof ExternalStateError))
        throw error
      await opts.retries.failed(path, 'recovery', error, error instanceof ExternalStateError)
      for (const name of protectedPaths)
        if (name !== path)
          await opts.retries.failed(name, 'recovery', error, error instanceof ExternalStateError)
    }
  }
  return report
}
