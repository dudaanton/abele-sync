import {
  AbeleError,
  caseKey,
  ScopedSnapshotPageSchema,
  ScopedFeedPageSchema,
  ScopedManifestItemSchema,
  type ScopedManifestItem,
  type ScopedSnapshotPage,
  type ScopedFeedPage,
  type ScopedCheckpoint,
  type ChangeItem,
} from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import { ExpectedWrites } from './echo.js'
import { PullPlacer } from './pullPlace.js'
import { pathProblem } from './apply.js'
import { ScopedState, type ScopedKnownFile } from './scopedState.js'
import { sameScopedConnection, type ScopedConnection } from './scopedIdentity.js'

export interface ScopedPullClient {
  binding: ScopedConnection
  negotiate(): Promise<{ state: { state: string; role: string } }>
  openSnapshot(): Promise<ScopedSnapshotPage>
  snapshotPage(id: string, cursor: string): Promise<ScopedSnapshotPage>
  feed(checkpoint: ScopedCheckpoint, limit?: number): Promise<ScopedFeedPage>
  head(fileId: string): Promise<ScopedManifestItem>
  version(fileId: string, versionId: string): Promise<Uint8Array>
}
export interface ScopedPullOptions {
  client: ScopedPullClient
  fs: FileSystem
  state: ScopedState
  expected?: ExpectedWrites
  stillHeld?: () => boolean
  configurationDirectories?: readonly string[]
}
export interface ScopedPullReport {
  applied: number
  held: string[]
  detached: string[]
  deleted: string[]
  complete: boolean
  checkpoint: ScopedCheckpoint | null
}
const forbidden =
  /\.(js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|fish|lua|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm|vbs)$/i
function safe(item: ScopedManifestItem, configuration: readonly string[]) {
  if (
    pathProblem(item.path) !== null ||
    forbidden.test(item.path) ||
    ['.obsidian', '.abele-sync', '.trash', ...configuration]
      .map(caseKey)
      .includes(caseKey(item.path.split('/')[0]!))
  )
    throw new EngineError('protocol', 'refused scoped script/settings path')
}
const record = (
  item: ScopedManifestItem,
  state: ScopedKnownFile['state'],
  dirty: boolean
): ScopedKnownFile => ({
  file_id: item.file_id,
  version_id: item.version_id,
  path: item.path,
  sha: item.sha,
  size: item.size,
  mtime: item.mtime,
  state,
  dirty,
})
/** Single runtime must serialize pull/push and hold its host's exclusive vault claim. */
export async function pullScoped(opts: ScopedPullOptions): Promise<ScopedPullReport> {
  const { client, state } = opts
  if (!sameScopedConnection(client.binding, state.binding))
    throw new EngineError('lost', 'scoped runtime connection mismatch')
  const check = () => {
    if (opts.stillHeld && !opts.stillHeld())
      throw new EngineError('lost', 'scoped vault claim lost')
  }
  check()
  const remote = await client.negotiate()
  if (remote.state.state !== 'active')
    throw new AbeleError('scope_updating', 'scoped view is preparing')
  const checkpoint = await state.getCheckpoint(),
    report: ScopedPullReport = {
      applied: 0,
      held: [],
      detached: [],
      deleted: [],
      complete: false,
      checkpoint,
    }
  const fs = new Proxy(opts.fs, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        if (['writeAtomic', 'move', 'remove'].includes(String(key))) check()
        return value.apply(target, args)
      }
    },
  })
  const placement = state.placementStore()
  const store = new Proxy(placement, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          if (['put', 'delete', 'setMeta', 'transaction'].includes(String(key))) check()
          return value.apply(target, args)
        }
      },
    }),
    expected = opts.expected ?? new ExpectedWrites()
  // A retained identity occupies its physical destination even after authority
  // departure. Never let the personal placer's clean-neighbour removal erase it.
  // Keep every claimant: a legacy held wire alias must not overwrite the
  // physical retained owner's claim merely because it was inserted later.
  const occupied = new Map<string, Set<string>>()
  const claim = (path: string, id: string) => {
    const key = caseKey(path),
      ids = occupied.get(key) ?? new Set<string>()
    ids.add(id)
    occupied.set(key, ids)
  }
  const release = (path: string, id: string) => {
    const key = caseKey(path),
      ids = occupied.get(key)
    ids?.delete(id)
    if (ids?.size === 0) occupied.delete(key)
  }
  for await (const entry of store.all()) {
    claim(entry.path, entry.fileId)
    claim(entry.wirePath, entry.fileId)
  }
  const objects = new Map<string, ScopedManifestItem>()
  const placer = new PullPlacer(
    {
      getBlob: async (sha) => {
        const item = objects.get(sha)
        if (!item) throw new EngineError('protocol', 'unbound scoped blob read')
        const bytes = await client.version(item.file_id, item.version_id)
        if (bytes.length !== item.size)
          throw new EngineError('protocol', 'scoped version length mismatch')
        return bytes
      },
    },
    fs,
    store,
    { dirty: new Set(), expected, filter: { excluded: () => false } },
    sha256
  )
  const known = async () => {
    const out: ScopedKnownFile[] = []
    for (let offset = 0; ; offset += 1000) {
      const page = await state.knownPage(offset)
      out.push(...page)
      if (page.length < 1000) break
    }
    return out
  }
  const detach = async (id: string, deleted: boolean) => {
    const old = await state.getKnown(id)
    if (!old) return // No synthetic identity or filesystem action for an unseen detach.
    const entry = await store.byFileId(id),
      dirty = old.dirty || (entry !== null && (await placer.edited(entry)))
    check()
    await state.putKnown({ ...old, state: deleted ? 'deleted' : 'detached', dirty })
    ;(deleted ? report.deleted : report.detached).push(id)
  }
  const materialize = async (item: ScopedManifestItem) => {
    safe(item, opts.configurationDirectories ?? [])
    const prior = await state.getKnown(item.file_id),
      entry = await store.byFileId(item.file_id)
    if (prior?.state === 'known_not_materialized') {
      check()
      await state.putKnown(record(item, 'known_not_materialized', false))
      return
    }
    const held = async () => {
      report.held.push(item.file_id)
      check()
      await state.putKnown(record(item, 'held', true))
    }
    if ([...(occupied.get(caseKey(item.path)) ?? [])].some((id) => id !== item.file_id))
      return held()
    if (entry) safe({ ...item, path: entry.wirePath }, opts.configurationDirectories ?? [])
    if (entry?.versionId === item.version_id && entry.wirePath === item.path) {
      if ((await fs.stat(entry.path)) === null) {
        report.held.push(item.file_id)
        check()
        await state.putKnown(record(item, 'held', true))
        return
      }
      check()
      await state.putKnown(record(item, 'materialized', await placer.edited(entry)))
      return
    }
    const change: ChangeItem = {
      seq: 0,
      kind: item.kind,
      at: new Date(item.mtime).toISOString(),
      file_id: item.file_id,
      version_id: item.version_id,
      op: 'modify',
      path: item.path,
      prev_path: entry?.wirePath !== item.path ? (entry?.wirePath ?? null) : null,
      sha: item.sha,
      size: item.size,
      mtime: item.mtime,
      actor: { kind: 'system', id: 'scoped', name: 'Scoped sync' },
    }
    objects.set(item.sha, item)
    check()
    // Exact durable own-write evidence precedes generic collision, dirty and
    // missing-source holds; content equality by itself remains insufficient.
    let placed = await placer.adopt(change, entry)
    if (!placed) {
      if (!entry && (await fs.stat(item.path)) !== null) return held()
      if (entry && (await fs.stat(entry.path)) === null) return held()
      if (entry && (await placer.edited(entry))) return held()
      placed = (await placer.place(change, item.sha, entry, new Map(), new Map())) === true
    }
    objects.delete(item.sha)
    if (placed !== true) return held()
    check()
    await state.putKnown(record(item, 'materialized', false))
    if (entry) {
      release(entry.path, item.file_id)
      release(entry.wirePath, item.file_id)
    }
    claim(item.path, item.file_id)
    report.applied++
  }
  if (checkpoint === null) {
    let page = ScopedSnapshotPageSchema.parse(await client.openSnapshot()),
      pages = 0
    const id = page.snapshot_id,
      anchor = JSON.stringify(page.checkpoint),
      items: ScopedManifestItem[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>()
    for (;;) {
      if (
        ++pages > 100000 ||
        page.snapshot_id !== id ||
        JSON.stringify(page.checkpoint) !== anchor ||
        cursors.has(page.cursor)
      )
        throw new EngineError('protocol', 'inconsistent scoped inventory')
      cursors.add(page.cursor)
      for (const item of page.items) {
        if (seen.has(item.file_id) || items.length >= 100000)
          throw new EngineError('protocol', 'duplicate or over-budget scoped inventory')
        safe(item, opts.configurationDirectories ?? [])
        seen.add(item.file_id)
        items.push(item)
      }
      if (page.next_cursor === null) break
      page = ScopedSnapshotPageSchema.parse(await client.snapshotPage(id, page.next_cursor))
    }
    // Do not mutate disk/ledger or infer absence before the complete collection and
    // its terminal-only feed proof have arrived in the same last response.
    if (!page.feed_checkpoint)
      throw new EngineError('protocol', 'snapshot terminal feed proof missing')
    for (const item of items) await materialize(item)
    for (const old of await known())
      if (!seen.has(old.file_id) && old.state !== 'detached' && old.state !== 'deleted')
        await detach(old.file_id, false)
    if (report.held.length === 0) {
      check()
      await state.setCheckpoint(page.feed_checkpoint)
      report.checkpoint = page.feed_checkpoint
      report.complete = true
    }
    return report
  }
  let page: ScopedFeedPage
  try {
    page = ScopedFeedPageSchema.parse(await client.feed(checkpoint))
  } catch (error) {
    if (error instanceof AbeleError && error.code === 'scope_unavailable') {
      check()
      await state.setCheckpoint(null)
    }
    throw error
  }
  // Resolve content identities to their current authorized head: opaque version
  // IDs provide no ordering, and an old feed event cannot overwrite a push result.
  const latest = new Map<string, ScopedFeedPage['events'][number]>()
  for (const event of page.events)
    latest.set(event.type === 'content' ? event.file.file_id : event.file_id, event)
  for (const [id, event] of latest) {
    if (event.type !== 'content') {
      await detach(id, event.type === 'deleted')
      continue
    }
    try {
      const head = ScopedManifestItemSchema.parse(await client.head(id))
      if (head.file_id !== id) throw new EngineError('protocol', 'scoped head identity mismatch')
      await materialize(head)
    } catch (error) {
      if (error instanceof AbeleError && error.code === 'not_found') {
        await detach(id, false)
        continue
      }
      throw error
    }
  }
  if (report.held.length === 0) {
    check()
    await state.setCheckpoint(page.checkpoint)
    report.checkpoint = page.checkpoint
    report.complete = !page.has_more
  }
  return report
}
