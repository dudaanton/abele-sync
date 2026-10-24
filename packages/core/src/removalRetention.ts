import type { ConditionalFileOperation, FileSystem, FileVersion } from './fs.js'
import { fingerprintFile } from './fs.js'
import type { StateEntry, StateStore } from './state.js'
import { sha256 } from './hash.js'
import { EngineError } from './errors.js'
import { transact } from './stateTransaction.js'
import { MAX_CHUNK_BYTES } from './streaming.js'

const SUMMARY = '.abele-sync/retained-removals/summary.json'
const DAY = 86400000
export interface RemovalRetentionPolicy {
  maxBytes?: number
  now?: () => number
  log?: (message: string) => void
}
export interface RemovalPublication {
  kind: 'installation' | 'stage'
  id: string
}
interface RetainedRemoval {
  id: string
  path: string
  victim: string
  capturedAt: number
  expected: FileVersion
  phase: 'prepared' | 'held' | 'committed' | 'restored'
  decision?: string
  publication?: RemovalPublication
}
interface Decision {
  id: string
  base: StateEntry
  committed: boolean
}
const decisionKey = (id: string) => `removal-decision:${id}`
const pointerKey = (base: StateEntry) => `removal-source:${base.fileId}`
const same = (a: StateEntry, b: StateEntry) =>
  (['path', 'wirePath', 'fileId', 'versionId', 'sha', 'size', 'mtime'] as const).every(
    (key) => a[key] === b[key]
  )
// Adapters may be wrapped independently for pause/error/host guards. Serialize
// summary mutations across wrappers too; object identity is not vault identity.
interface RetentionRuntime {
  queue: Promise<unknown>
  volatile: Map<string, { base: StateEntry; committed: boolean }>
}
const runtimeKey = Symbol.for('abele.sync.removal-retention-runtime-v1')
const shared = globalThis as unknown as Record<symbol, RetentionRuntime | undefined>
const runtime = (shared[runtimeKey] ??= { queue: Promise.resolve(), volatile: new Map() })
const volatile = runtime.volatile
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const result = runtime.queue.then(work, work)
  runtime.queue = result.then(
    () => {},
    () => {}
  )
  return result
}

/** One metadata summary; startup never walks or hashes retention contents. */
export async function retentionSnapshot(fs: FileSystem): Promise<RetainedRemoval[]> {
  if ((await fs.stat(SUMMARY)) === null) return []
  let text: string
  if (fs.openRead) {
    const source = await fs.openRead(SUMMARY),
      decoder = new TextDecoder(),
      pieces: string[] = []
    try {
      for (let offset = 0; offset < source.size;) {
        const bytes = await source.read(offset, Math.min(MAX_CHUNK_BYTES, source.size - offset))
        if (!bytes.length) throw new EngineError('io', 'truncated removal summary')
        offset += bytes.length
        pieces.push(decoder.decode(bytes, { stream: true }))
      }
      pieces.push(decoder.decode())
      await source.assertUnchanged()
      text = pieces.join('')
    } finally {
      await source.close()
    }
  } else text = new TextDecoder().decode(await fs.read(SUMMARY))
  const raw: unknown = JSON.parse(text)
  return decodeRetentionSnapshot(raw)
}
export function decodeRetentionSnapshot(raw: unknown): RetainedRemoval[] {
  if (!Array.isArray(raw)) throw new EngineError('io', 'invalid removal retention summary')
  const ids = new Set<string>()
  for (const row of raw) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row.path !== 'string' ||
      row.path.startsWith('/') ||
      row.path.split('/').some((part: string) => !part || part === '.' || part === '..') ||
      row.path.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(row.path) ||
      row.victim !== `.abele-sync/retained-removals/${row.id}/victim` ||
      !Number.isSafeInteger(row.capturedAt) ||
      row.capturedAt < 0 ||
      !['prepared', 'held', 'committed', 'restored'].includes(row.phase) ||
      !row.expected ||
      !Number.isSafeInteger(row.expected.size) ||
      row.expected.size < 0 ||
      !Number.isSafeInteger(row.expected.mtime) ||
      row.expected.mtime < 0 ||
      !/^[a-f0-9]{64}$/.test(row.expected.sha) ||
      (row.expected.identity !== undefined && typeof row.expected.identity !== 'string') ||
      (row.decision !== undefined &&
        row.decision !== decisionKey(row.id) &&
        row.decision !== `volatile-removal:${row.id}`) ||
      (row.publication !== undefined &&
        (!row.publication ||
          !['installation', 'stage'].includes(row.publication.kind) ||
          typeof row.publication.id !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(row.publication.id)))
    )
      throw new EngineError('io', 'invalid removal retention owner')
    ids.add(row.id)
  }
  return raw as RetainedRemoval[]
}
async function save(fs: FileSystem, rows: RetainedRemoval[]) {
  await fs.writeAtomic(SUMMARY, new TextEncoder().encode(JSON.stringify(rows)), Date.now())
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new EngineError('protocol', 'invalid retention clock')
  return value
}
async function version(fs: FileSystem, path: string): Promise<FileVersion | null> {
  const info = await fs.stat(path)
  if (!info) return null
  const identity = await fs.fileIdentity?.(path)
  const content = await fingerprintFile(fs, path, sha256)
  const after = await fs.stat(path)
  if (!after) return null
  if (
    info.size !== content.size ||
    after.size !== content.size ||
    info.mtime !== after.mtime ||
    (identity !== undefined && identity !== (await fs.fileIdentity?.(path)))
  )
    throw new EngineError('conflict', 'retained object changed during verification')
  return {
    size: content.size,
    mtime: info.mtime,
    sha: content.sha,
    ...(identity ? { identity } : {}),
  }
}
async function matches(fs: FileSystem, row: RetainedRemoval): Promise<boolean> {
  const got = await version(fs, row.victim)
  return (
    got !== null &&
    got.size === row.expected.size &&
    got.mtime === row.expected.mtime &&
    got.sha === row.expected.sha &&
    (row.expected.identity === undefined || got.identity === row.expected.identity)
  )
}
async function restore(fs: FileSystem, row: RetainedRemoval): Promise<boolean> {
  const current = await version(fs, row.victim)
  if (!current) return true
  // conditional move publishes exclusively; ordinary host move may check then overwrite.
  for (let n = 0; n < 100; n++) {
    const to =
      n === 0 ? row.path : `${row.path}.sync-conflict-${row.id}${n === 1 ? '' : `-${n - 1}`}`
    if ((await fs.stat(to)) !== null) continue
    if (
      await fs.conditionalFile?.({
        path: row.victim,
        expected: current,
        effect: { kind: 'move', to },
      })
    )
      return true
    // A concurrent writer changed the capture. Preserve it for another recovery.
    if ((await fs.stat(to)) === null) return false
  }
  return false
}

/** Host entry point. Capture is reversible; an optional core decision owns eligibility.
 * No public unlink or authorization-to-unlink interval exists. */
export async function retainRemoval(
  fs: FileSystem,
  op: ConditionalFileOperation,
  options: { id?: string; decision?: string; now?: number; clock?: () => number } = {}
): Promise<boolean> {
  op = {
    ...op,
    expected: op.expected === null ? null : { ...op.expected },
    effect: { ...op.effect },
  }
  if (op.effect.kind !== 'remove') throw new EngineError('protocol', 'expected removal')
  return exclusive(async () => {
    const rows = await retentionSnapshot(fs)
    if (
      rows.some(
        (row) => row.path === op.path && row.phase !== 'committed' && row.phase !== 'restored'
      )
    )
      return false
    if (op.expected === null || (await fs.stat(op.path)) === null)
      return (await fs.conditionalFile?.({ ...op, expected: null })) ?? false
    const id = options.id ?? crypto.randomUUID()
    const row: RetainedRemoval = {
      id,
      path: op.path,
      victim: `.abele-sync/retained-removals/${id}/victim`,
      capturedAt: timestamp(options.clock?.() ?? options.now ?? Date.now()),
      expected: op.expected,
      phase: 'prepared',
      ...(options.decision ? { decision: options.decision } : {}),
    }
    rows.push(row)
    await save(fs, rows)
    let captured: boolean | undefined
    try {
      captured = await fs.conditionalFile?.({
        path: op.path,
        expected: op.expected,
        effect: { kind: 'move', to: row.victim },
      })
    } catch (error) {
      // An allocation with no transferred victim owns no bytes. The host's
      // conditional journal still owns any interrupted internal capture.
      if ((await fs.stat(row.victim)) === null)
        await save(
          fs,
          rows.filter((one) => one.id !== id)
        )
      throw error
    }
    if (!captured) {
      if ((await fs.stat(row.victim)) === null)
        await save(
          fs,
          rows.filter((one) => one.id !== id)
        )
      return false
    }
    row.phase = 'held'
    const capturedIdentity = await fs.fileIdentity?.(row.victim)
    if (row.expected.identity === undefined && capturedIdentity)
      row.expected = { ...row.expected, identity: capturedIdentity }
    row.capturedAt = timestamp(options.clock?.() ?? options.now ?? Date.now())
    await save(fs, rows)
    let accepted = false
    try {
      accepted = (!op.authorize || (await op.authorize())) && (await matches(fs, row))
    } finally {
      if (!accepted && (await restore(fs, row))) {
        await fs.removeDirectory?.(row.victim.slice(0, row.victim.lastIndexOf('/')))
        await save(
          fs,
          rows.filter((one) => one.id !== id)
        )
      }
    }
    if (!accepted) return false
    if (!row.decision) {
      row.phase = 'committed'
      await save(fs, rows)
    }
    return true
  })
}

export async function captureRemoval(
  fs: FileSystem,
  state: StateStore,
  base: StateEntry,
  authorize: () => Promise<boolean>,
  now?: number,
  capturedIdentity?: string | null,
  expected: FileVersion = base
): Promise<boolean> {
  base = { ...base }
  expected = { ...expected }
  if (!fs.conditionalFile) return false
  if (!(await authorize())) return false
  const id = crypto.randomUUID(),
    key = decisionKey(id)
  const identity =
    capturedIdentity !== undefined ? capturedIdentity : await fs.fileIdentity?.(base.path)
  await exclusive(async () => {
    await state.setMeta?.(`pull-base:${base.path}`, JSON.stringify({ base }))
  })
  if (identity === null || (await fs.stat(base.path)) === null)
    return await retainRemoval(fs, {
      path: base.path,
      expected: null,
      effect: { kind: 'remove' },
      authorize,
    })
  if (!state.getMeta || !state.setMeta) {
    volatile.set(id, { base, committed: false })
    let captured = false
    try {
      captured = await retainRemoval(
        fs,
        {
          path: base.path,
          expected: { ...expected, ...(identity ? { identity } : {}) },
          effect: { kind: 'remove' },
          authorize,
        },
        { id, decision: `volatile-removal:${id}`, now }
      )
      return captured
    } finally {
      if (!captured) volatile.delete(id)
    }
  }
  const claimed = await exclusive(() =>
    transact(state, async (tx) => {
      if (await tx.getMeta!(pointerKey(base))) return false
      await tx.setMeta!(key, JSON.stringify({ id, base, committed: false } satisfies Decision))
      await tx.setMeta!(pointerKey(base), id)
      return true
    })
  )
  if (!claimed) return false
  let captured = false
  try {
    captured = await retainRemoval(
      fs,
      {
        path: base.path,
        expected: { ...expected, ...(identity ? { identity } : {}) },
        effect: { kind: 'remove' },
        authorize,
      },
      { id, decision: key, now }
    )
    return captured
  } finally {
    if (!captured && !(await retentionSnapshot(fs)).some((row) => row.id === id))
      await transact(state, async (tx) => {
        const raw = await tx.getMeta!(key)
        if (
          raw &&
          (JSON.parse(raw) as Decision).id === id &&
          !(JSON.parse(raw) as Decision).committed
        )
          await tx.setMeta!(key, null)
        if ((await tx.getMeta!(pointerKey(base))) === id) await tx.setMeta!(pointerKey(base), null)
      })
  }
}

/** A replacement's displaced object shares its installation/stage owner's
 * acknowledgement; moving its private alias does not dispose of any bytes. */
export async function retainPublishedVictim(
  fs: FileSystem,
  source: string,
  path: string,
  expected: FileVersion,
  publication?: RemovalPublication
): Promise<void> {
  await exclusive(async () => {
    const rows = await retentionSnapshot(fs),
      id = crypto.randomUUID()
    const row: RetainedRemoval = {
      id,
      path,
      victim: `.abele-sync/retained-removals/${id}/victim`,
      expected,
      capturedAt: Date.now(),
      phase: 'prepared',
      ...(publication ? { publication } : {}),
    }
    rows.push(row)
    await save(fs, rows)
    if (
      !(await fs.conditionalFile?.({
        path: source,
        expected,
        effect: { kind: 'move', to: row.victim },
      }))
    )
      throw new EngineError('conflict', 'displaced publication object changed')
    row.phase = publication ? 'held' : 'committed'
    const capturedIdentity = await fs.fileIdentity?.(row.victim)
    if (row.expected.identity === undefined && capturedIdentity)
      row.expected = { ...row.expected, identity: capturedIdentity }
    row.capturedAt = Date.now()
    await save(fs, rows)
  })
}

/** Called only when the installation/stage owner retires after its decision.
 * Persist the local retention handover before removing that owner's evidence. */
export async function acknowledgePublication(
  fs: FileSystem,
  publication: RemovalPublication
): Promise<void> {
  await exclusive(async () => {
    const rows = await retentionSnapshot(fs)
    let changed = false
    for (const row of rows)
      if (row.publication?.kind === publication.kind && row.publication.id === publication.id) {
        if (row.phase === 'prepared') row.capturedAt = Date.now()
        row.phase = 'committed'
        delete row.publication
        changed = true
      }
    if (changed) await save(fs, rows)
  })
}

/** Publish in the SAME transaction as the caller's ledger transition. */
export async function commitRemoval(
  state: StateStore,
  base: StateEntry,
  fs?: FileSystem
): Promise<void> {
  if (!state.getMeta || !state.setMeta) {
    const owners = fs
      ? (await retentionSnapshot(fs)).flatMap((row) => {
          const owner = volatile.get(row.id)
          return row.decision === `volatile-removal:${row.id}` && owner && same(owner.base, base)
            ? [owner]
            : []
        })
      : []
    if (owners.length > 1) throw new EngineError('conflict', 'ambiguous removal owner')
    const owner = owners[0]
    if (owner)
      state.afterCommit?.(() => {
        owner.committed = true
      })
    return
  }
  const id = await state.getMeta?.(pointerKey(base))
  if (!id) return
  const key = decisionKey(id),
    raw = await state.getMeta?.(key)
  if (!raw) throw new EngineError('conflict', 'removal owner disappeared')
  const decision = JSON.parse(raw) as Decision
  if (decision.id !== id || !same(decision.base, base))
    throw new EngineError('conflict', 'removal owner changed')
  await state.setMeta!(key, JSON.stringify({ ...decision, committed: true }))
}

/** Root recovery, outside all transactions. Ownership transfers to the local
 * summary only after the ledger decision has been reloaded as committed. */
export async function recoverRemovals(
  fs: FileSystem,
  state?: StateStore,
  policy: RemovalRetentionPolicy = {},
  onlyPath?: string
): Promise<void> {
  await exclusive(async () => {
    let rows = await retentionSnapshot(fs)
    const now = timestamp(policy.now?.() ?? Date.now()),
      cap = policy.maxBytes ?? 1024 * 1024 * 1024
    if (!Number.isSafeInteger(cap) || cap < 0)
      throw new EngineError('protocol', 'invalid retention byte limit')
    // A crash can leave the durable claim before any filesystem allocation.
    // No summary owner means no victim was transferred into this namespace.
    const allocations = new Set((await state?.metadataKeys?.('removal-decision:')) ?? [])
    if (state?.getMeta && !state.metadataKeys)
      for await (const base of state.all()) {
        if (onlyPath !== undefined && base.path !== onlyPath) continue
        const id = await state.getMeta(pointerKey(base))
        if (id) allocations.add(decisionKey(id))
      }
    for (const key of allocations) {
      const raw = await state!.getMeta!(key)
      if (!raw) continue
      const decision = JSON.parse(raw) as Decision
      if (rows.some((row) => row.id === decision.id)) continue
      if (onlyPath !== undefined && decision.base.path !== onlyPath) continue
      await transact(state!, async (tx) => {
        if ((await tx.getMeta!(key)) !== raw) return
        await tx.setMeta!(key, null)
        if ((await tx.getMeta!(pointerKey(decision.base))) === decision.id)
          await tx.setMeta!(pointerKey(decision.base), null)
      })
    }
    for (const row of [...rows]) {
      if (onlyPath !== undefined && row.path !== onlyPath) continue
      if (row.publication) {
        if (row.phase !== 'prepared' || (await fs.stat(row.victim)) !== null) continue
        row.phase = 'restored'
        delete row.publication
      }
      const ephemeral = row.decision?.startsWith('volatile-removal:')
      const live = ephemeral ? volatile.get(row.id) : undefined
      if (row.decision && !state && !ephemeral) continue
      const raw = row.decision && !ephemeral ? await state!.getMeta?.(row.decision) : null
      const decision = raw ? (JSON.parse(raw) as Decision) : null
      if (row.phase !== 'committed' && row.phase !== 'restored') {
        // Capture may have finished long after the allocation timestamp, then
        // crashed before acknowledgement. Restart its conservative minimum age.
        if (row.phase === 'prepared') row.capturedAt = now
        if (live?.committed || (decision?.id === row.id && decision.committed))
          row.phase = 'committed'
        else if (await restore(fs, row)) row.phase = 'restored'
        await save(fs, rows)
      }
      if (row.phase !== 'committed' && row.phase !== 'restored') continue
      if (row.decision && raw) {
        await transact(state!, async (tx) => {
          if ((await tx.getMeta?.(row.decision!)) !== raw) return
          await tx.setMeta!(row.decision!, null)
          if ((await tx.getMeta?.(pointerKey(decision!.base))) === row.id)
            await tx.setMeta!(pointerKey(decision!.base), null)
        })
      }
      if (row.decision) {
        if (ephemeral) volatile.delete(row.id)
        delete row.decision
        await save(fs, rows)
      }
      if (row.phase === 'restored') {
        await fs.removeDirectory?.(row.victim.slice(0, row.victim.lastIndexOf('/')))
        rows = rows.filter((one) => one.id !== row.id)
        await save(fs, rows)
      }
    }
    // Standalone departure replay owns recovery of its capture, not the host's
    // reclamation policy. Cycle/host maintenance supplies that policy separately.
    if (onlyPath !== undefined) return
    let total = rows.reduce((sum, row) => sum + row.expected.size, 0)
    for (const row of [...rows].sort(
      (a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id)
    )) {
      if (
        row.phase !== 'committed' ||
        now - row.capturedAt < DAY ||
        (total <= cap && now - row.capturedAt < 7 * DAY)
      )
        continue
      if (!(await matches(fs, row))) {
        if (!(await restore(fs, row))) continue
      } else {
        // The public name is never touched. D-163 accepts writers held open past
        // this final proof/reclamation; earlier writes are preserved above.
        await fs.remove(row.victim)
      }
      total -= row.expected.size
      await fs.removeDirectory?.(row.victim.slice(0, row.victim.lastIndexOf('/')))
      rows = rows.filter((one) => one.id !== row.id)
      await save(fs, rows)
    }
    if (total > cap)
      policy.log?.(
        `removal retention: ${total} bytes exceeds ${cap}; victims younger than 24 hours remain protected`
      )
  })
}
