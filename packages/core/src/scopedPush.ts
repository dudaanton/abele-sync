import {
  AbeleError,
  caseKey,
  ScopedCommitRequestSchema,
  ScopedCommitResponseSchema,
  type ScopedCommitRequest,
  type ScopedCommitResponse,
  type ChangeItem,
  type ScopedManifestItem,
} from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import { sha256 } from './hash.js'
import type { FileSystem } from './fs.js'
import { ScopedState, type ScopedJournal } from './scopedState.js'
import { sameScopedConnection, type ScopedConnection } from './scopedIdentity.js'
import { PullPlacer } from './pullPlace.js'
import { ExpectedWrites } from './echo.js'
import type { StateEntry } from './state.js'
import { pathProblem } from './apply.js'
import { scopedPathAllowed } from './scopedSafety.js'
export interface ScopedPushClient {
  binding: ScopedConnection
  negotiate(): Promise<{ state: { state: string; role: string } }>
  putBlob(sha: string, bytes: Uint8Array): Promise<unknown>
  commit(request: ScopedCommitRequest): Promise<ScopedCommitResponse>
  version(file: string, version: string): Promise<Uint8Array>
}
export interface ScopedPushOptions {
  client: ScopedPushClient
  state: ScopedState
  fs: FileSystem
  ops?: ScopedCommitRequest['ops']
  stillHeld?: () => boolean
  expected?: ExpectedWrites
  configurationDirectories?: readonly string[]
  beforeUpload?: (journal: ScopedJournal) => Promise<void>
  onSettled?: (item: ScopedManifestItem, bytes: Uint8Array, requestId: string) => Promise<void>
}
export interface ScopedPushReport {
  committed: boolean
  acknowledged: boolean
  held: string[]
  requestId: string | null
}
/** Journal and immutable bytes precede upload. Recovery reuses the same scoped body request ID. */
export async function pushScoped(opts: ScopedPushOptions): Promise<ScopedPushReport> {
  const { state, client } = opts,
    check = () => {
      if (opts.stillHeld && !opts.stillHeld())
        throw new EngineError('lost', 'scoped writer claim lost')
    }
  if (!sameScopedConnection(state.binding, client.binding))
    throw new EngineError('lost', 'scoped push binding mismatch')
  check()
  const remote = await client.negotiate(),
    store = state.placementStore()
  let journal = await state.getJournal()
  if (!journal) {
    if (!opts.ops?.length)
      return { committed: false, acknowledged: false, held: [], requestId: null }
    if (remote.state.role !== 'editor')
      throw new AbeleError('forbidden', 'editor authority required')
    if (remote.state.state !== 'active')
      throw new AbeleError('scope_updating', 'scoped view preparing')
    const ops = ScopedCommitRequestSchema.shape.ops.parse(opts.ops),
      requestId = crypto.randomUUID(),
      sources: NonNullable<ScopedJournal['sources']> = []
    let stagedBytes = 0
    for (const [index, op] of ops.entries()) {
      if (
        (op.op === 'create' && !scopedPathAllowed(op.path, opts.configurationDirectories)) ||
        (op.op === 'move' && !scopedPathAllowed(op.to_path, opts.configurationDirectories))
      )
        throw new EngineError('conflict', 'scoped scripts/settings refused')
      const known = 'file_id' in op ? await state.getKnown(op.file_id) : null
      if (
        'file_id' in op &&
        (!known || ['detached', 'known_not_materialized'].includes(known.state))
      )
        throw new EngineError('conflict', 'unavailable identity retained locally')
      const base = 'file_id' in op ? await store.byFileId(op.file_id) : null
      if (base && !scopedPathAllowed(base.wirePath, opts.configurationDirectories))
        throw new EngineError('conflict', 'scoped scripts/settings refused')
      const sourcePath = op.op === 'create' ? op.path : base?.path
      if (op.op === 'create' && (await store.get(op.path)))
        throw new EngineError('conflict', 'create cannot adopt a managed identity')
      if ('sha' in op || op.op === 'move') {
        if (!sourcePath || pathProblem(sourcePath) !== null)
          throw new EngineError('conflict', 'no exact local source')
        const bytes = await opts.fs.read(sourcePath),
          sha = await sha256(bytes),
          stat = await opts.fs.stat(sourcePath)
        if (!stat || ('sha' in op && (sha !== op.sha || bytes.length !== op.size)))
          throw new EngineError('conflict', 'source changed before staging')
        stagedBytes += bytes.length
        if (stagedBytes > 256 * 1024 * 1024)
          throw new EngineError('conflict', 'scoped outbox budget reached')
        const stagedPath = `.abele-sync/scoped-outbox/${requestId}/${index}-${sha}`
        check()
        await opts.fs.writeAtomic(stagedPath, bytes, stat.mtime)
        sources.push({
          index,
          sourcePath,
          stagedPath,
          sha,
          size: bytes.length,
          mtime: stat.mtime,
          base,
        })
      }
    }
    journal = {
      kind: 'scoped',
      binding: state.binding,
      request_id: requestId,
      ops,
      startedAt: new Date().toISOString(),
      phase: 'prepared',
      sources,
    }
    check()
    await state.setJournal(journal)
  }
  if (!journal.sources || !journal.phase)
    throw new EngineError('lost', 'legacy scoped journal requires explicit source recovery')
  const sources = journal.sources,
    unitOps = journal.ops
  for (const source of sources)
    if (
      source.stagedPath !==
      `.abele-sync/scoped-outbox/${journal.request_id}/${source.index}-${source.sha}`
    )
      throw new EngineError('lost', 'unbound staged source')
  const uploadSources = async () => {
    await opts.beforeUpload?.(journal!)
    const sent = new Set<string>()
    for (const source of sources) {
      const op = unitOps[source.index]
      if (!op || !('sha' in op) || sent.has(op.sha)) continue
      const bytes = await opts.fs.read(source.stagedPath)
      if (bytes.length !== source.size || (await sha256(bytes)) !== op.sha)
        throw new EngineError('lost', 'staged source lost or corrupt')
      check()
      await client.putBlob(op.sha, bytes)
      sent.add(op.sha)
    }
  }
  if (journal.phase === 'prepared') {
    await uploadSources()
    journal = { ...journal, phase: 'staged' }
    check()
    await state.setJournal(journal)
  }
  const send = async () => {
    check()
    return ScopedCommitResponseSchema.parse(
      await client.commit({ request_id: journal!.request_id, ops: journal!.ops })
    )
  }
  let response: ScopedCommitResponse
  try {
    response = await send()
  } catch (error) {
    // Always replay first. A committed receipt returns its filtered outcome,
    // including compact acknowledgement, without a re-upload. A generic missing
    // input may be an expired entitlement: re-prove only immutable own bytes and
    // retry the SAME identity once; all server target/base checks still apply.
    if (
      !(error instanceof AbeleError && error.code === 'not_found') ||
      !sources.some((source) => {
        const op = journal!.ops[source.index]
        return op && 'sha' in op
      })
    )
      throw error
    await uploadSources()
    response = await send()
  }
  const occupiedByOther = async (path: string, id: string) => {
    const key = caseKey(path)
    for await (const entry of store.all())
      if (entry.fileId !== id && (caseKey(entry.path) === key || caseKey(entry.wirePath) === key))
        return true
    return false
  }
  const held: string[] = []
  if (response.acknowledged && response.results.length === 0)
    return {
      committed: true,
      acknowledged: true,
      held: journal.ops.flatMap((op) => ('file_id' in op ? [op.file_id] : [])),
      requestId: journal.request_id,
    }
  if (response.results.length !== journal.ops.length)
    throw new EngineError('protocol', 'scoped outcome cardinality mismatch')
  const latest = new Map<
    string,
    { result: ScopedCommitResponse['results'][number]; index: number }
  >()
  response.results.forEach((result, index) => latest.set(result.file_id, { result, index }))
  for (const { result, index } of latest.values()) {
    const op = journal.ops[index]!,
      source = sources.find((one) => one.index === index)
    if (result.status === 'acknowledged' || (result.status === 'applied' && result.sha === null)) {
      if (op.op !== 'delete')
        throw new EngineError('conflict', 'non-delete compact result needs reconciliation')
      const known = await state.getKnown(op.file_id)
      if (known) {
        check()
        await state.putKnown({ ...known, state: 'deleted', dirty: false })
      }
      continue
    }
    const outputs = [
      {
        file_id: result.file_id,
        version_id: result.version_id,
        path: result.path,
        sha: result.sha!,
        size: result.size,
        mtime: result.mtime,
      },
      ...(result.status === 'conflict'
        ? [
            {
              file_id: result.conflict_file_id,
              version_id: result.conflict_version_id,
              path: result.conflict_path,
              sha: source?.sha ?? '',
              size: source?.size ?? 0,
              mtime: source?.mtime ?? 0,
            },
          ]
        : []),
    ]
    for (const output of outputs) {
      if (!scopedPathAllowed(output.path, opts.configurationDirectories))
        throw new EngineError('protocol', 'invalid outcome path')
      const actual = await store.byFileId(output.file_id)
      const alreadyPlaced = actual?.versionId === output.version_id
      const submitted = alreadyPlaced
        ? actual
        : source && output.file_id === result.file_id && op.op !== 'move'
          ? {
              path: source.sourcePath,
              wirePath: source.sourcePath,
              fileId: output.file_id,
              versionId: source.base?.versionId ?? `pending-${journal.request_id}`,
              sha: source.sha,
              size: source.size,
              mtime: source.mtime,
            }
          : op.op === 'move' && source?.base
            ? source.base
            : actual
      const view = {
        ...store,
        get: async (path: string) => (submitted?.path === path ? submitted : store.get(path)),
        byFileId: async (id: string) => (submitted?.fileId === id ? submitted : store.byFileId(id)),
      }
      const change: ChangeItem = {
        ...output,
        seq: 0,
        op: 'modify',
        prev_path: submitted?.wirePath !== output.path ? (submitted?.wirePath ?? null) : null,
        kind: output.path.endsWith('.md')
          ? 'note'
          : output.path.endsWith('.canvas')
            ? 'canvas'
            : 'attachment',
        at: new Date().toISOString(),
        actor: { kind: 'system', id: 'scoped', name: 'Scoped sync' },
      }
      const bytes = await client.version(output.file_id, output.version_id)
      if (bytes.length !== output.size || (await sha256(bytes)) !== output.sha)
        throw new EngineError('protocol', 'invalid settled version bytes')
      const guardedFs = new Proxy(opts.fs, {
        get(target, key) {
          const fn = Reflect.get(target, key)
          return typeof fn !== 'function'
            ? fn
            : (...args: unknown[]) => {
                if (['writeAtomic', 'move', 'remove'].includes(String(key))) check()
                return fn.apply(target, args)
              }
        },
      })
      const placer = new PullPlacer(
        { getBlob: async () => bytes },
        guardedFs,
        view,
        {
          dirty: new Set(),
          expected: opts.expected ?? new ExpectedWrites(),
          filter: { excluded: () => false },
        },
        sha256
      )
      check()
      // The personal placer may remove clean neighbour identities. A scoped
      // settlement cannot: departed/deleted retained work still owns that slot.
      const blocked = await occupiedByOther(output.path, output.file_id)
      const placed = blocked
        ? false
        : alreadyPlaced
          ? actual !== null && actual.path === output.path && !(await placer.edited(actual))
          : (await placer.adopt(change, submitted)) ||
            (await placer.place(
              change,
              output.sha,
              submitted,
              new Map([[output.sha, bytes]]),
              new Map()
            ))
      if (placed !== true) {
        held.push(output.file_id)
        const path = submitted?.path ?? output.path
        const entry: StateEntry = {
          path,
          wirePath: output.path,
          fileId: output.file_id,
          versionId: output.version_id,
          sha: output.sha,
          size: output.size,
          mtime: output.mtime,
        }
        check()
        // A held destination is remote known-state only, not a claim to an
        // actual placement. SQLite also enforces wire-path uniqueness; publishing
        // that alias would evict retained work even if its physical path is free.
        if (
          !blocked &&
          !(await occupiedByOther(entry.path, output.file_id)) &&
          !(await occupiedByOther(entry.wirePath, output.file_id))
        )
          await store.put(entry)
      }
      check()
      await state.putKnown({
        ...output,
        state: placed === true ? 'materialized' : 'held',
        dirty: placed !== true,
        ...(op.op === 'create' || output.file_id !== result.file_id ? { native: true } : {}),
      })
      await opts.onSettled?.(
        { ...output, kind: change.kind as ScopedManifestItem['kind'] },
        bytes,
        journal.request_id
      )
    }
  }
  check()
  await state.finishPush()
  for (const source of sources) {
    check()
    await opts.fs.remove(source.stagedPath)
  }
  return { committed: true, acknowledged: false, held, requestId: journal.request_id }
}
