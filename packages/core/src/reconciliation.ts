import type { FileInfo, FileSystem } from './fs.js'
import { revalidationPaths, scan, type ScanFilter, type ScanResult } from './scanner.js'
import type { StateEntry, StateStore } from './state.js'
import type { EngineClient } from './engineClient.js'
import { fingerprintFile } from './fs.js'
import { encodeText, sha256 } from './hash.js'
import { downloadToStage, MAX_TEXT_BYTES, TransferBudget } from './streaming.js'
import { AbeleError, fitGeneratedName, type ChangeItem } from '@abele/sync-protocol'
import { isEngineOwn } from './selective.js'
import { StagedChanges } from './defer.js'
import { DeleteHolds, DEFAULT_DELETE_WINDOW_MS } from './deletes.js'
import { checkCancellation } from './cancellation.js'
import { authoredJournal } from './journalOrigin.js'
import { scanHintEpoch, readScanHint, writeScanHint } from './scanHints.js'

async function stagedPaths(state: StateStore): Promise<Set<string>> {
  const paths = new Set<string>()
  for (const record of await new StagedChanges(state).list()) {
    const entry = await state.byFileId(record.change.file_id)
    for (const path of [
      record.change.path,
      record.change.prev_path,
      record.settled?.path,
      entry?.wirePath,
    ])
      if (path) paths.add(path)
  }
  return paths
}

export const RECONCILIATION_KEY = 'content-reconciliation'
export interface ReconciliationState {
  phase: 'requested' | 'review' | 'complete'
  reason: string
}

export async function readReconciliation(state: StateStore): Promise<ReconciliationState | null> {
  const raw = await state.getMeta?.(RECONCILIATION_KEY)
  if (!raw) return null
  const value = JSON.parse(raw) as ReconciliationState
  if (
    !['requested', 'review', 'complete'].includes(value.phase) ||
    typeof value.reason !== 'string'
  )
    throw new Error('invalid reconciliation state; preserve the ledger for recovery')
  return value
}

export async function requestReconciliation(
  state: StateStore,
  reason = 'requested by host'
): Promise<void> {
  if (!state.setMeta) throw new Error('reconciliation requires durable metadata')
  const decision = await state.getMeta?.('delete-decision')
  const decisionKey = decision
    ? `reconciliation-decision:${await sha256(encodeText(decision))}`
    : null
  await state.transaction(async () => {
    if (decisionKey) {
      await state.setMeta!(decisionKey, decision!)
      await state.setMeta!('delete-decision', null)
    }
    await state.setMeta!(RECONCILIATION_KEY, JSON.stringify({ phase: 'requested', reason }))
    await state.setMeta!('scan-hint-epoch', crypto.randomUUID())
  })
}

/** Hosts that replay publication during startup must call this before replay, too. */
export async function fenceRestoredJournal(
  state: StateStore,
  head: number,
  fs?: FileSystem,
  liveJournalKey?: string,
  client?: EngineClient
): Promise<void> {
  const journal = await state.getJournal()
  if (!journal?.ops.some((op) => op.op === 'delete' || op.op === 'move')) return
  let reconciliation = await readReconciliation(state)
  if (
    (journal.idempotencyKey === liveJournalKey ||
      (fs !== undefined && (await authoredJournal(state, journal, fs)))) &&
    (!reconciliation || reconciliation.phase === 'complete')
  )
    return
  if (
    head > (await state.getCursor()) &&
    (!reconciliation ||
      reconciliation.phase === 'complete' ||
      (await state.getMeta?.('delete-decision')))
  ) {
    await requestReconciliation(
      state,
      'server advanced with an unresolved destructive journal; possible restored profile'
    )
    reconciliation = await readReconciliation(state)
  }
  if (!reconciliation || reconciliation.phase === 'complete') return
  if (!state.setMeta) throw new Error('cannot preserve a restored publication journal')
  for (const op of journal.ops) {
    if (op.op !== 'create' && op.op !== 'modify') continue
    const path = op.op === 'create' ? op.path : (await state.byFileId(op.file_id))?.path
    let recoverable = false
    if (fs && path) {
      try {
        recoverable = (await fingerprintFile(fs, path, sha256)).sha === op.sha
      } catch {
        // The ledger and exact journal stay intact for operator recovery.
      }
    }
    if (!recoverable)
      throw new Error(
        'restored mixed publication has unsent bytes missing or changed on disk; journal preserved, manual recovery required'
      )
  }
  let alreadyDeleted = 0
  const generation = (await state.getMeta?.('server-restore-generation')) ?? 'legacy'
  const tallyKey = `reconciliation-tallied:${generation}:${journal.idempotencyKey}`
  if (client && (await state.getMeta?.(tallyKey)) !== 'yes')
    for (const op of journal.ops) {
      if (op.op !== 'delete') continue
      const history = await client.versions(op.file_id, { limit: 2 }).catch((error) => {
        if (error instanceof AbeleError && error.code === 'not_found') return []
        throw error
      })
      // Read evidence only: never replay ambiguous destructive intent to discover a receipt.
      if (history[0]?.op === 'delete' && history[1]?.version_id === op.base_version_id)
        alreadyDeleted++
    }
  await state.transaction(async () => {
    await state.setMeta!(
      `reconciliation-journal:${journal.idempotencyKey}`,
      JSON.stringify(journal)
    )
    await state.setJournal(null)
    if (alreadyDeleted && (await state.getMeta?.(tallyKey)) !== 'yes') {
      await new DeleteHolds(state).tally(Date.now(), alreadyDeleted, DEFAULT_DELETE_WINDOW_MS)
      await state.setMeta!(tallyKey, 'yes')
    }
  })
}

/** Binary conflict rules retain the older variant only in history. During recovery retain
 * a visible, deterministic copy as well, before publishing anything that can replace it. */
export async function preserveRestoredEdits(
  client: EngineClient,
  fs: FileSystem,
  state: StateStore,
  found: ScanResult,
  filter?: ScanFilter,
  retiredAuthority = false,
  deferred?: (path: string) => boolean
): Promise<void> {
  const staged = await stagedPaths(state)
  for (const op of found.ops) {
    if (op.op !== 'modify') continue
    const entry = await state.byFileId(op.file_id)
    if (!entry) continue
    if (staged.has(entry.wirePath) || deferred?.(entry.wirePath)) continue
    // Notes already merge or receive the server's stable conflict copy; retain that rule.
    if (entry.wirePath.toLowerCase().endsWith('.md')) continue
    const head = (
      await client.versions(entry.fileId, { limit: 1 }).catch((error) => {
        // A file created after the server backup has no remote variant to preserve.
        if (error instanceof AbeleError && error.code === 'not_found') return []
        throw error
      })
    )[0]
    if (
      !head ||
      head.sha === null ||
      (!retiredAuthority && head.version_id === entry.versionId) ||
      head.sha === op.sha
    )
      continue
    const copyRemote = op.mtime > head.mtime
    const copy = copyRemote ? { sha: head.sha, size: head.size, mtime: head.mtime } : op
    const slash = entry.path.lastIndexOf('/')
    const folder = entry.path.slice(0, slash + 1)
    const file = entry.path.slice(slash + 1)
    const dot = file.lastIndexOf('.')
    const stem = dot > 0 ? file.slice(0, dot) : file
    const ext = dot > 0 ? file.slice(dot) : ''
    for (let n = 0; ; n++) {
      const wire = fitGeneratedName(
        folder.normalize('NFC'),
        stem.normalize('NFC'),
        ext.normalize('NFC'),
        ` (Conflicted copy ${copyRemote ? 'remote' : 'restored'} ${copy.sha.slice(0, 16)}${n ? ` ${n}` : ''})`
      )
      // Fit the wire spelling, then retain the actual disk parent. A full parent
      // may force the fitter's root fallback; do not reattach that parent then.
      const slash = wire.lastIndexOf('/')
      const path = slash < 0 ? wire : folder + wire.slice(slash + 1)
      const wirePath = path.normalize('NFC')
      if ((client.includes && !client.includes(wirePath)) || filter?.excluded(wirePath, copy.size))
        throw new Error(
          'restored conflict copy falls outside the sync selection; original bytes preserved'
        )
      if (await fs.stat(path)) {
        if ((await fingerprintFile(fs, path, sha256)).sha === copy.sha) break
        continue
      }
      if (fs.beginAtomicWrite && (copyRemote ? client.openVersion : fs.openRead)) {
        const source = copyRemote
          ? await client.openVersion!(entry.fileId, head.version_id, copy)
          : await fs.openRead!(entry.path)
        const stage = await fs.beginAtomicWrite(path, copy.mtime, null).catch(async (error) => {
          await source.close()
          throw error
        })
        try {
          await downloadToStage(source, stage, copy, new TransferBudget())
        } catch (error) {
          await stage.discard()
          throw error
        }
      } else {
        if (copy.size > MAX_TEXT_BYTES)
          throw new Error('restored conflict needs streaming copy support')
        const bytes = copyRemote
          ? await client.versionBytes(entry.fileId, head.version_id)
          : await fs.read(entry.path)
        if (bytes.length !== copy.size || (await sha256(bytes)) !== copy.sha)
          throw new Error('restored edit changed during recovery')
        if (!fs.conditionalFile)
          throw new Error('restored conflict needs conditional publication support')
        if (
          !(await fs.conditionalFile({
            path,
            expected: null,
            effect: { kind: 'write', bytes, mtime: copy.mtime },
          }))
        )
          continue
      }
      break
    }
  }
}

/** Compare every divergent binary held by the generation manifest, including unchanged
 * old-profile bytes. Retired ledger equality does not make those bytes equal to this server. */
export async function preserveGenerationConflicts(
  client: EngineClient,
  fs: FileSystem,
  state: StateStore,
  found: ScanResult,
  held: readonly ChangeItem[],
  filter: ScanFilter
): Promise<void> {
  const entries: StateEntry[] = []
  const ops: ScanResult['ops'] = []
  for (const change of held) {
    const sha = found.hashes.get(change.path)
    const info = found.infos.get(change.path)
    if (
      !sha ||
      !info ||
      change.sha === null ||
      change.size === null ||
      change.mtime === null ||
      sha === change.sha
    )
      continue
    entries.push({
      path: found.diskPaths.get(change.path) ?? change.path,
      wirePath: change.path,
      fileId: change.file_id,
      versionId: change.version_id,
      sha: change.sha,
      size: change.size,
      mtime: change.mtime,
    })
    ops.push({
      op: 'modify',
      file_id: change.file_id,
      base_version_id: change.version_id,
      sha,
      size: info.size,
      mtime: info.mtime,
    })
  }
  await preserveRestoredEdits(
    client,
    fs,
    await comparisonState(state, entries),
    { ...found, ops },
    filter,
    true
  )
}

/** Retired entries may explain disk bytes but never regain publication authority. */
async function comparisonState(
  state: StateStore,
  retired: readonly StateEntry[]
): Promise<StateStore> {
  const entries = new Map(retired.map((entry) => [entry.wirePath, entry]))
  for await (const entry of state.all()) entries.set(entry.wirePath, entry)
  const byPath = new Map([...entries.values()].map((entry) => [entry.path, entry]))
  const byId = new Map([...entries.values()].map((entry) => [entry.fileId, entry]))
  // Retired entries are comparison evidence only. Writes always use the current ledger.
  return {
    async *all() {
      for (const entry of entries.values()) yield { ...entry }
    },
    async get(path) {
      return byPath.get(path) ?? null
    },
    async byFileId(id) {
      return byId.get(id) ?? null
    },
    put: (entry) => state.put(entry),
    delete: (path) => state.delete(path),
    getCursor: () => state.getCursor(),
    setCursor: (cursor) => state.setCursor(cursor),
    getJournal: () => state.getJournal(),
    setJournal: (journal) => state.setJournal(journal),
    transaction: (work) => state.transaction(work),
    getMeta: (key) => state.getMeta?.(key) ?? null,
    setMeta: (key, value) => state.setMeta?.(key, value),
  }
}

export async function reconciliationScan(
  fs: FileSystem,
  state: StateStore,
  filter: ScanFilter,
  head: number,
  liveJournalKey?: string,
  retiredEntries?: readonly StateEntry[],
  startup = true,
  client?: EngineClient,
  signal?: AbortSignal
): Promise<{ found: ScanResult; reconciliation: ReconciliationState | null; basis: StateStore }> {
  const basis = retiredEntries ? await comparisonState(state, retiredEntries) : state
  let reconciliation = await readReconciliation(state)
  const missingBefore = new Set<string>(
    JSON.parse((await state.getMeta?.('content-missing')) ?? '[]')
  )
  const missing: string[] = []
  const absent: string[] = []
  const staged = await stagedPaths(state)
  const entries = new Map<string, StateEntry>()
  const files = new Map<string, FileInfo>()
  const disk = new Map<string, FileInfo>()
  for await (const info of fs.list()) disk.set(info.path, info)
  const older: Array<{ entry: StateEntry; info: FileInfo }> = []
  let reason: string | null = null
  for await (const entry of basis.all()) {
    checkCancellation(signal)
    if (isEngineOwn(entry.wirePath) || filter.excluded(entry.wirePath, entry.size)) continue
    entries.set(entry.wirePath, entry)
    const info = disk.get(entry.path)
    if (info && filter.excluded(entry.wirePath, info.size)) continue
    if (!info) {
      absent.push(entry.wirePath)
      if (!staged.has(entry.wirePath)) missing.push(entry.wirePath)
    } else {
      files.set(entry.wirePath, info)
      if (!staged.has(entry.wirePath)) {
        if (info.mtime < entry.mtime) older.push({ entry, info })
        if (missingBefore.has(entry.wirePath))
          reason = 'previously missing tracked files reappeared'
      }
    }
  }
  const changedOlder: typeof older = []
  if (older.length > 1) {
    for (const { entry, info } of older) {
      checkCancellation(signal)
      if ((await fingerprintFile(fs, info.path, sha256, signal)).sha !== entry.sha)
        changedOlder.push({ entry, info })
      if (changedOlder.length > 1) {
        reason = 'multiple tracked files have changed content with older timestamps'
        break
      }
    }
  }
  // One backdated edit alone is normal (including an ordinary binary race).
  // But if a causally newer remote version has an even older wall clock, normal
  // binary resolution would hide it in history. Preserve both before publication;
  // version identity, rather than that wall clock, establishes the divergence.
  if (
    client &&
    !reason &&
    !retiredEntries &&
    (older.length === 1 || changedOlder.length === 1) &&
    head > (await state.getCursor())
  ) {
    const { entry, info } = (changedOlder[0] ?? older[0])!
    if (!entry.wirePath.toLowerCase().endsWith('.md')) {
      const latest = (
        await client.versions(entry.fileId, { limit: 1 }).catch((error) => {
          if (error instanceof AbeleError && error.code === 'not_found') return []
          throw error
        })
      )[0]
      if (
        latest &&
        latest.version_id !== entry.versionId &&
        latest.sha !== null &&
        info.mtime > latest.mtime
      ) {
        const { sha } = await fingerprintFile(fs, info.path, sha256, signal)
        if (sha !== entry.sha && sha !== latest.sha)
          reason = 'backdated local binary diverges from a newer remote version with an older clock'
      }
    }
  }
  if (retiredEntries && older.length > 0)
    reason = 'tracked files have older timestamps than the ledger'
  await state.setMeta?.('content-missing', JSON.stringify(missing))
  const journal = await state.getJournal()
  const destructive = journal?.ops.some((op) => op.op === 'delete' || op.op === 'move') ?? false
  const liveJournal =
    journal !== null &&
    (journal.idempotencyKey === liveJournalKey || (await authoredJournal(state, journal, fs)))
  let unexplainedAbsence = missing.length > 0
  if (
    client &&
    missing.length > 0 &&
    missing.length <= 16 &&
    startup &&
    head > (await state.getCursor())
  ) {
    unexplainedAbsence = false
    for (const path of missing) {
      const entry = entries.get(path)!
      const latest = (
        await client.versions(entry.fileId, { limit: 1 }).catch((error) => {
          if (error instanceof AbeleError && error.code === 'not_found') return []
          throw error
        })
      )[0]
      if (!latest || latest.version_id === entry.versionId) {
        unexplainedAbsence = true
        break
      }
    }
  }
  if (
    !retiredEntries &&
    !liveJournal &&
    head > (await state.getCursor()) &&
    ((startup && unexplainedAbsence) || destructive)
  )
    reason = 'server advanced while local destructive intent remained; possible restored profile'
  if (
    reason &&
    (!reconciliation ||
      reconciliation.phase === 'complete' ||
      (head > (await state.getCursor()) && (await state.getMeta?.('delete-decision'))))
  ) {
    await requestReconciliation(state, reason)
    reconciliation = await readReconciliation(state)
  }
  if (retiredEntries && reason && reconciliation?.phase === 'requested')
    reconciliation.reason += `; local restore evidence: ${reason}`
  const active = reconciliation !== null && reconciliation.phase !== 'complete'
  const directoryDocument = await state.getMeta?.('v2-directories')
  const pendingDirectory = directoryDocument
    ? (JSON.parse(directoryDocument) as { pending?: { op?: { op?: string } } }).pending
    : undefined
  if (
    pendingDirectory &&
    ['delete_directory', 'move_directory'].includes(pendingDirectory.op?.op ?? '') &&
    (active || head > (await state.getCursor()))
  ) {
    if (!active)
      await requestReconciliation(state, 'possible restored destructive directory journal')
    throw new Error(
      'restored directory publication requires manual review; directory journal preserved'
    )
  }
  await fenceRestoredJournal(state, head, fs, liveJournalKey, client)
  let found: ScanResult
  if (reconciliation?.phase === 'requested') {
    found = await scan(fs, basis, filter, {
      revalidate: 'all',
      pairMoves: false,
      signal,
      persistHints: true,
    })
  } else {
    // The ordinary preflight already stats tracked entries. Reuse it for rolling
    // hashes and pull protection; fresh files and rename pairing belong to the final scan.
    found = {
      ops: [],
      hashes: new Map(),
      diskPaths: new Map(),
      infos: new Map(),
      dirty: new Set(absent),
      skipped: [],
      collisions: [],
    }
    const selected = await revalidationPaths(files, state, { revalidate: 16 })
    const epoch = await scanHintEpoch(state)
    for (const [path, info] of files) {
      checkCancellation(signal)
      const entry = entries.get(path)!
      const changed = info.size !== entry.size || info.mtime !== entry.mtime
      if (changed) found.dirty.add(path)
      if (!selected.has(path) && !changed) continue
      try {
        const cached = !selected.has(path) ? await readScanHint(state, info, epoch) : null
        const fingerprint =
          cached === null
            ? await fingerprintFile(fs, info.path, sha256, signal)
            : { sha: cached, size: info.size }
        if (fingerprint.size !== info.size)
          throw new Error('file changed during content revalidation')
        if (cached === null) {
          const after = await fs.stat(info.path)
          if (after?.size === info.size && after.mtime === info.mtime)
            await writeScanHint(state, info, epoch, fingerprint.sha)
        }
        found.hashes.set(path, fingerprint.sha)
        found.diskPaths.set(path, info.path)
        found.infos.set(path, info)
        if (fingerprint.sha !== entry.sha) {
          found.dirty.add(path)
          found.ops.push({
            op: 'modify',
            file_id: entry.fileId,
            base_version_id: entry.versionId,
            sha: fingerprint.sha,
            size: info.size,
            mtime: info.mtime,
          })
        }
      } catch (error) {
        found.skipped.push({
          path: info.path,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  if (active && found.skipped.length > 0)
    throw new Error(
      `content reconciliation incomplete: ${found.skipped.length} paths could not be inspected`
    )
  return { found, reconciliation, basis }
}
