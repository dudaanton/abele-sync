import {
  AbeleError,
  decodeAccessToken,
  groupLinkKey,
  parseGroupFrontmatter,
  resolveGroupLink,
  V2ConnectionSchema,
  V2ManifestSchema,
  V2ChangesSchema,
  V2CommitResponseSchema,
  V2EventSchema,
  VaultSettingsSchema,
  UploadBeginResponseSchema,
  ExternalVerifyRequestSchema,
  ExternalVerifyResponseSchema,
  ManifestItemSchema,
  VersionInfoSchema,
  TrashItemSchema,
  CommitOpResultSchema,
  TRASH_RESTORE_MAX,
  EXTERNAL_FILES_VERSION_HEADER,
  type V2AccessToken,
  type V2Connection,
  type V2CommitResponse,
  type V2ManifestItem,
  type ManifestItem,
  type ChangeItem,
  type CommitOp,
  type CommitOpResult,
  type VaultState,
  type VersionInfo,
  type TrashItem,
  type ExternalVerifyRequest,
} from '@abele/sync-protocol'
import type { EngineClient, CommitOutcome, VersionsQuery } from './engineClient.js'
import { EngineError } from './errors.js'
import { MEMBERS_KEY, reconcileGeneration } from './restoreGeneration.js'
import type { StateEntry } from './state.js'
import { Http, idempotency, type ClientOptions } from './http.js'
import type { FileSystem } from './fs.js'
import { fingerprintFile } from './fs.js'
import type { StateStore } from './state.js'
import { sha256 } from './hash.js'
import { V2Directories } from './v2Directories.js'
import { z } from 'zod'
import { sha256 as incrementalSha256 } from '@noble/hashes/sha256'
import { MAX_CHUNK_BYTES, type ChunkSource, type ContentIdentity } from './streaming.js'
import { negotiateExternalFiles, checkedExternalVerification } from './externalVerification.js'
import { isFinalForBatch } from './commitErrors.js'
import { scanHintEpoch } from './scanHints.js'

const NoteCacheSchema = z.object({
  epoch: z.string(),
  entries: z.array(
    z.tuple([
      z.string(),
      z.object({
        size: z.number().nonnegative(),
        mtime: z.number(),
        sha: z.string(),
        links: z.array(z.string()),
      }),
    ])
  ),
})

/** One production transport for root, folder and group token connections.
 * Wire authority is always v2. Engine-local file/version shapes are not v1 routes. */
export class V2EngineClient implements EngineClient {
  readonly checksBlobBeforeUpload = true as const
  readonly reportSizeRefusals = true
  readonly readEffects = true as const
  private readonly http: Http
  private connectionInfo: V2Connection | undefined
  private readonly files = new Map<string, Extract<V2ManifestItem, { sha: string }>>()
  private readonly byteSources = new Map<string, Extract<V2ManifestItem, { sha: string }>>()
  private ports: { fs: FileSystem; state: StateStore } | undefined
  private directories: V2Directories | undefined
  private readonly departed = new Set<string>()
  private readonly localGroupPaths = new Set<string>()
  private readonly authoredDepartures = new Set<string>()
  private readonly restoreAssets = new Set<string>()
  private readonly localNoteCache = new Map<
    string,
    { size: number; mtime: number; sha: string; links: string[] }
  >()
  private readonly item: string | undefined
  readonly token: V2AccessToken
  constructor(encoded: string, options: Omit<ClientOptions, 'baseUrl' | 'token'>) {
    this.token = decodeAccessToken(encoded)
    this.item = options.item
    this.http = new Http({ ...options, baseUrl: this.token.address, token: this.token.key })
  }
  async connection(signal?: AbortSignal) {
    const value = await this.http.json(V2ConnectionSchema, 'GET', '/v2/connection', { signal })
    if (value.status !== 'active')
      throw new AbeleError(value.status, 'connection scope is not ready')
    this.connectionInfo = value
    return value
  }
  includes(path: string) {
    path = path.normalize('NFC')
    const preview =
      this.token.v === 1
        ? this.token.scope
        : (this.token.items.find((i) => i.id === this.item) ?? this.token.items[0]!)
    const scope = this.connectionInfo?.scope ?? preview
    if (scope.kind !== 'folder')
      return (
        !path.startsWith('.obsidian/') &&
        (this.localGroupPaths.has(path) || (!this.departed.has(path) && this.files.has(path)))
      )
    if (this.departed.has(path)) return false
    return (
      scope.path === '/' ||
      ((path === scope.path || path.startsWith(scope.path + '/')) && !path.startsWith('.obsidian/'))
    )
  }
  private directoryState(
    fs: FileSystem,
    state: StateStore,
    excludeDirectory: (path: string) => boolean = () => false,
    signal?: AbortSignal
  ) {
    return new V2Directories(
      fs,
      state,
      (path) => this.includes(path) && !excludeDirectory(path),
      async (ops, key) => {
        const response = await this.http.send('POST', '/v2/commit', {
          json: { ops },
          ...idempotency(key),
        })
        return (await this.http.decode(V2CommitResponseSchema, response, 'POST', '/v2/commit'))
          .results
      },
      signal,
      (path) => !excludeDirectory(path)
    )
  }

  async loadPathRefusals(fs: FileSystem, state: StateStore): Promise<void> {
    this.directories = this.directoryState(fs, state)
    await this.directories.loadRefusals()
  }

  async prepare(
    fs: FileSystem,
    state: StateStore,
    excludeDirectory: (path: string) => boolean = () => false,
    signal?: AbortSignal,
    deferLocalScan = false
  ) {
    if (!state.getMeta || !state.setMeta)
      throw new AbeleError('invalid_request', 'token sync requires durable metadata state ports')
    this.ports = { fs, state }
    this.http.generation = undefined
    await this.connection(signal)
    const generation = this.http.observedGeneration
    if (await reconcileGeneration(state, generation)) {
      this.files.clear()
      this.byteSources.clear()
      this.localNoteCache.clear()
    }
    this.http.generation = generation
    this.localNoteCache.clear()
    try {
      const cached = NoteCacheSchema.parse(
        JSON.parse((await state.getMeta('v2-local-note-cache')) ?? 'null')
      )
      if (cached.epoch === (await scanHintEpoch(state)))
        for (const [path, note] of cached.entries) this.localNoteCache.set(path, note)
    } catch {
      /* Missing or stale hints require fresh inspection, never recovery. */
    }
    this.authoredDepartures.clear()
    for (const path of JSON.parse(
      (await state.getMeta!('v2-authored-departures')) ?? '[]'
    ) as string[])
      this.authoredDepartures.add(path)
    this.departed.clear()
    for (const path of JSON.parse((await state.getMeta!('v2-departures')) ?? '[]') as string[])
      this.departed.add(path)
    this.directories = this.directoryState(fs, state, excludeDirectory, signal)
    await this.directories.loadRefusals()
    await this.directories.retireRecreatedDelete()
    const members = JSON.parse((await state.getMeta(MEMBERS_KEY)) ?? '[]') as StateEntry[]
    this.restoreAssets.clear()
    for (const entry of members)
      if (!entry.wirePath.toLowerCase().endsWith('.md')) this.restoreAssets.add(entry.wirePath)
    const current: StateEntry[] = []
    for await (const entry of state.all()) {
      signal?.throwIfAborted()
      current.push(entry)
    }
    for (const entry of [...members, ...current])
      if (!this.departed.has(entry.wirePath)) {
        const item = {
          file_id: entry.fileId,
          version_id: entry.versionId,
          path: entry.wirePath,
          sha: entry.sha,
          size: entry.size,
          mtime: entry.mtime,
          kind: entry.wirePath.endsWith('.md') ? ('note' as const) : ('attachment' as const),
        }
        this.files.set(entry.wirePath, item)
        this.byteSources.set(entry.sha, item)
      }
    if (!deferLocalScan) await this.scanLocal(fs, signal)
  }
  async scanLocal(fs: FileSystem, signal?: AbortSignal, changed?: ReadonlySet<string>) {
    for (const path of this.localNoteCache.keys())
      if (changed?.has(path.normalize('NFC'))) this.localNoteCache.delete(path)
    if (this.connectionInfo?.scope.kind === 'group') await this.groupEligibility(fs, signal)
  }
  /** Only note frontmatter grants local eligibility. Attachments remain tracked-only until
   * an explicit host publication call. The same bounded resolver runs on both ends. */
  private async groupEligibility(fs: FileSystem, signal?: AbortSignal) {
    this.localGroupPaths.clear()
    const notes: Array<{ id: string; path: string; sha: string; links: string[] }> = []
    const bindings = JSON.parse(
      (await this.ports!.state.getMeta!('v2-local-group-links')) ?? '{}'
    ) as Record<string, Record<string, string | null>>
    const nextBindings: typeof bindings = {}
    const listed = new Set<string>()
    for await (const file of fs.list()) {
      signal?.throwIfAborted()
      if (
        !file.path.toLowerCase().endsWith('.md') ||
        file.path.startsWith('.obsidian/') ||
        file.path.startsWith('.abele-sync/')
      )
        continue
      const wirePath = file.path.normalize('NFC')
      listed.add(wirePath)
      let cached = this.localNoteCache.get(file.path)
      if (!cached || cached.mtime !== file.mtime || cached.size !== file.size) {
        let bytes: Uint8Array
        try {
          if (fs.openRead) {
            const source = await fs.openRead(file.path)
            try {
              bytes =
                source.size === 0
                  ? new Uint8Array()
                  : await source.read(0, Math.min(source.size, 1024 * 1024))
              await source.assertUnchanged()
            } finally {
              await source.close()
            }
          } else bytes = await fs.read(file.path)
        } catch (error) {
          // Missing membership is not established by an unreadable note. Keep the
          // prior membership document and retry before applying scoped feed items.
          throw error
        }
        const links = parseGroupFrontmatter(new TextDecoder().decode(bytes))
          .groups.map((link) => groupLinkKey(link, file.path))
          .filter((key): key is string => key !== null)
        cached = {
          size: file.size,
          mtime: file.mtime,
          sha: (await fingerprintFile(fs, file.path, sha256)).sha,
          links,
        }
        this.localNoteCache.set(file.path, cached)
      }
      notes.push({
        id: this.files.get(wirePath)?.file_id ?? 'local:' + wirePath,
        path: wirePath,
        sha: cached.sha,
        links: cached.links,
      })
    }
    for (const path of this.localNoteCache.keys())
      if (!listed.has(path.normalize('NFC'))) this.localNoteCache.delete(path)
    // Let the ordinary scanner see a uniquely matching renamed tracked note, even
    // when it is the group's root (which need not list itself in frontmatter).
    // Without this bridge, filtering the new path turns a rename into root deletion.
    const missing = [...this.files.values()].filter(
      (file) => file.kind === 'note' && !listed.has(file.path) && !this.departed.has(file.path)
    )
    for (const file of missing) {
      const candidates = notes.filter(
        (note) => note.id.startsWith('local:') && note.sha === file.sha
      )
      if (candidates.length === 1 && missing.filter((other) => other.sha === file.sha).length === 1)
        candidates[0]!.id = file.file_id
    }
    const root = this.connectionInfo!.scope
    if (!notes.some((note) => note.id === root.id))
      notes.push({ id: root.id, path: root.path, sha: '', links: [] })
    const reverse = new Map<string, string[]>()
    const paths = new Map(notes.map((note) => [note.id, note.path]))
    for (const note of notes) {
      const old = bindings[note.id] ?? bindings['local:' + note.path] ?? {}
      const links: Record<string, string | null> = {}
      for (const key of note.links) {
        let target = old[key] ?? resolveGroupLink(key, notes)
        if (target?.startsWith('local:'))
          target = notes.find((note) => note.path === target!.slice(6))?.id ?? target
        links[key] = target
        if (target) reverse.set(target, [...(reverse.get(target) ?? []), note.id])
      }
      nextBindings[note.id] = links
    }
    await this.ports!.state.setMeta!('v2-local-group-links', JSON.stringify(nextBindings))
    const seen = new Set<string>(),
      queue = [root.id]
    while (queue.length) {
      const id = queue.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const path = paths.get(id)
      if (path) this.localGroupPaths.add(path)
      queue.push(...(reverse.get(id) ?? []))
    }
    await this.ports!.state.setMeta!(
      'v2-local-note-cache',
      JSON.stringify({
        epoch: await scanHintEpoch(this.ports!.state),
        entries: [...this.localNoteCache],
      })
    )
  }
  /** Publication is deliberate and connection-bound. A path/hash discovered by indexing
   * never calls this method; hosts invoke it only after their durable consent decision. */
  async publishGroupAsset(path: string, bytes: Uint8Array, mtime: number, key: string) {
    const sha = await sha256(bytes)
    await this.putBlob(sha, bytes)
    return this.http.json(V2CommitResponseSchema, 'POST', '/v2/group-assets', {
      json: { path, sha, size: bytes.length, mtime },
      ...idempotency(key),
    })
  }
  async state(): Promise<VaultState> {
    const info = await this.connection()
    const feed = await this.http.json(V2ChangesSchema, 'GET', '/v2/changes', {
      query: { since: Number.MAX_SAFE_INTEGER, limit: 1 },
    })
    return {
      head_seq: feed.cursor,
      settings: VaultSettingsSchema.parse({
        max_file_bytes: info.limits.max_file_bytes,
        quota_bytes: info.limits.quota_bytes,
      }),
      usage: {
        live_bytes: 0,
        history_bytes: 0,
        trash_bytes: 0,
        quota_bytes: info.limits.quota_bytes,
        by_kind: {},
      },
    }
  }
  private async fileItem(item: V2ManifestItem, seq: number): Promise<ManifestItem | null> {
    if (item.kind === 'directory') {
      await this.directories?.receive(item)
      return null
    }
    this.departed.delete(item.path)
    if (this.ports)
      await this.ports.state.setMeta!('v2-departures', JSON.stringify([...this.departed]))
    this.files.set(item.path, item)
    this.byteSources.set(item.sha, item)
    return { ...item, seq }
  }
  rememberManifest(items: readonly ManifestItem[]): void {
    for (const item of items) {
      this.departed.delete(item.path)
      this.files.set(item.path, item)
      this.byteSources.set(item.sha, item)
    }
  }
  async manifest(cursor: string | null, limit?: number, signal?: AbortSignal) {
    const page = await this.http.json(V2ManifestSchema, 'GET', '/v2/manifest', {
      query: { next: cursor, limit },
      signal,
    })
    const items: ManifestItem[] = []
    for (const item of page.items) {
      signal?.throwIfAborted()
      const file = await this.fileItem(item, page.cursor)
      if (file) items.push(file)
    }
    return { items, next: page.next, head_seq: page.cursor }
  }
  async changes(since: number, limit?: number, signal?: AbortSignal) {
    const page = await this.http.json(V2ChangesSchema, 'GET', '/v2/changes', {
      query: { since, limit },
      signal,
    })
    const items: ChangeItem[] = []
    for (const event of page.items) {
      signal?.throwIfAborted()
      if (event.type === 'content') {
        if (event.prev_path) this.files.delete(event.prev_path)
        const file = await this.fileItem(event.item, event.cursor)
        if (!file) continue
        items.push({
          ...file,
          op: event.prev_path ? 'move' : 'modify',
          prev_path: event.prev_path,
          actor: { kind: 'key', id: this.connectionInfo!.token_id, name: 'token connection' },
          at: event.at,
        })
      } else {
        const entry = this.ports ? await this.ports.state.byFileId(event.file_id) : null
        this.files.delete(event.path)
        if (event.type === 'removal') {
          const retain =
            this.authoredDepartures.has(event.path) ||
            ((await this.onRemoval?.(event.file_id, event.path)) ?? false)
          this.authoredDepartures.delete(event.path)
          if (this.ports)
            await this.ports.state.setMeta!(
              'v2-authored-departures',
              JSON.stringify([...this.authoredDepartures])
            )
          await this.directories?.departed(event.file_id, retain)
          this.departed.add(event.path)
          if (this.ports)
            await this.ports.state.setMeta!('v2-departures', JSON.stringify([...this.departed]))
          if (entry) {
            // A host with overlapping connections decides whether the local bytes still
            // have a covering connection. A departure never becomes a global delete.
            let removed = false
            if (!retain) {
              await this.ports!.state.setMeta!(
                `pull-base:${entry.path}`,
                JSON.stringify({ base: entry })
              )
              removed =
                (await this.ports!.fs.conditionalFile?.({
                  path: entry.path,
                  expected: entry,
                  effect: { kind: 'remove' },
                })) ?? false
            }
            // A refused effect means an unpushed save still depends on this base.
            // Keep it across departures/rejoins rather than adopting that save as clean.
            if (retain || removed) await this.ports!.state.delete(entry.path)
          }
          continue
        }
        if (!entry) {
          // Directory departure owns its cleanup; only unknown/file identities
          // need a tombstone in the file feed before their ledger entry exists.
          if (await this.directories?.knows(event.file_id)) {
            await this.directories!.departed(event.file_id)
            continue
          }
        }
        items.push({
          seq: event.cursor,
          file_id: event.file_id,
          path: event.path,
          kind: (entry?.wirePath ?? event.path).endsWith('.md') ? 'note' : 'attachment',
          version_id: event.version_id,
          op: 'delete',
          prev_path: null,
          sha: null,
          size: null,
          mtime: null,
          actor: { kind: 'key', id: this.connectionInfo!.token_id, name: 'token connection' },
          at: event.at,
        })
      }
    }
    return {
      items,
      head_seq: page.next === null ? page.cursor : Number.MAX_SAFE_INTEGER,
      next_since: page.cursor,
    }
  }
  syncDirectories() {
    return this.directories?.scan() ?? Promise.resolve()
  }
  directoryRefusals() {
    return this.directories?.refusals() ?? []
  }
  pathRefusal(path: string) {
    return this.directories?.refusalFor(path)
  }
  async retryRefusedDirectories(paths?: readonly string[]) {
    await this.directories?.loadRefusals(true, paths)
  }
  finishPull() {
    return this.directories?.finishPull() ?? Promise.resolve()
  }
  /** True retains local bytes; hosts check other covering connections under their path lock. */
  onRemoval?: (fileId: string, path: string) => Promise<boolean>
  async commitRaw(ops: CommitOp[], key: string): Promise<CommitOutcome> {
    // Record before the request, so losing its response cannot delete the author's local
    // note when the accepted group departure is pulled after journal replay/restart.
    if (this.connectionInfo?.scope.kind === 'group' && this.ports) {
      for (const op of ops)
        if (op.op === 'modify') {
          const item = [...this.files.values()].find((file) => file.file_id === op.file_id)
          if (item && !this.localGroupPaths.has(item.path)) this.authoredDepartures.add(item.path)
        }
      await this.ports.state.setMeta!(
        'v2-authored-departures',
        JSON.stringify([...this.authoredDepartures])
      )
    }
    const { body, replayed } = await this.sendCommit(ops, key)
    return {
      body: { head_seq: body.cursor, results: body.results },
      replayed,
    }
  }
  private async sendCommit(
    ops: CommitOp[],
    key: string
  ): Promise<{ body: V2CommitResponse; replayed: boolean }> {
    const assets =
      this.connectionInfo?.scope.kind === 'group'
        ? ops.filter((op) => op.op === 'create' && this.restoreAssets.has(op.path))
        : []
    if (assets.length === 0) {
      const response = await this.http.send('POST', '/v2/commit', {
        json: { ops },
        ...idempotency(key),
      })
      return {
        body: await this.http.decode(V2CommitResponseSchema, response, 'POST', '/v2/commit'),
        replayed: response.headers.get('idempotent-replayed') === 'true',
      }
    }
    // These paths were already shared under this connection, rather than discovered private
    // attachments. Re-establish their publication explicitly in the restored namespace.
    const regular = ops.filter((op) => !assets.includes(op))
    const results = new Map<CommitOp, CommitOpResult>()
    let cursor = 0
    let replayed = false
    if (regular.length) {
      try {
        const sent = await this.sendCommit(regular, `${key}:files`)
        cursor = sent.body.cursor
        replayed = sent.replayed
        regular.forEach((op, i) => results.set(op, sent.body.results[i]!))
      } catch (error) {
        if (!isFinalForBatch(error)) throw error
        for (const op of regular)
          results.set(op, { status: 'rejected', code: error.code, message: error.message })
      }
    }
    for (const [index, op] of assets.entries()) {
      if (op.op !== 'create') continue
      try {
        const response = await this.http.send('POST', '/v2/group-assets', {
          json: { path: op.path, sha: op.sha, size: op.size, mtime: op.mtime },
          ...idempotency(`${key}:asset:${index}`),
        })
        const body = await this.http.decode(
          V2CommitResponseSchema,
          response,
          'POST',
          '/v2/group-assets'
        )
        cursor = Math.max(cursor, body.cursor)
        replayed ||= response.headers.get('idempotent-replayed') === 'true'
        results.set(op, body.results[0]!)
      } catch (error) {
        if (!isFinalForBatch(error)) throw error
        results.set(op, { status: 'rejected', code: error.code, message: error.message })
      }
    }
    return { body: { cursor, results: ops.map((op) => results.get(op)!) }, replayed }
  }
  async commit(ops: CommitOp[], key: string) {
    return (await this.commitRaw(ops, key)).body
  }
  // The server checks token/scope entitlement before consulting its shared store.
  async hasBlob(sha: string, signal?: AbortSignal) {
    return (await this.http.send('HEAD', `/v2/uploads/${sha}`, { signal }, [404])).status === 200
  }
  async getBlob(sha: string, signal?: AbortSignal): Promise<Uint8Array> {
    let file = this.byteSources.get(sha)
    if (!file) {
      let cursor: string | null = null
      do {
        const page = await this.manifest(cursor, undefined, signal)
        cursor = page.next
      } while (cursor)
      file = this.byteSources.get(sha)
    }
    if (!file) throw new AbeleError('not_found', 'no authorized file version for these bytes')
    return this.versionBytes(file.file_id, file.version_id, signal)
  }
  versionBytes(fileId: string, versionId: string, signal?: AbortSignal) {
    return this.http.bytes('GET', `/v2/files/${encodeURIComponent(fileId)}/content`, {
      query: { version_id: versionId },
      signal,
    })
  }
  async openVersion(
    fileId: string,
    versionId: string,
    expected: import('./streaming.js').ContentIdentity,
    signal?: AbortSignal
  ) {
    return this.http.openRange(`/v2/files/${encodeURIComponent(fileId)}/content`, expected, {
      query: { version_id: versionId },
      ...(signal === undefined ? {} : { signal }),
    })
  }
  async putBlob(sha: string, bytes: Uint8Array, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (await this.hasBlob(sha, signal)) {
      if ((await sha256(bytes)) !== sha)
        throw new AbeleError('hash_mismatch', 'source content changed')
      return
    }
    const path = `/v2/uploads/${sha}`
    if (bytes.length <= this.http.simpleUploadBytes) {
      await this.http.send('PUT', path, { bytes, signal })
      return
    }
    const upload = await this.http.json(UploadBeginResponseSchema, 'POST', path + '/begin', {
      json: { size: bytes.length },
      signal,
    })
    const parts = Math.ceil(bytes.length / upload.part_size)
    if (parts !== upload.parts) throw new EngineError('protocol', 'invalid multipart layout')
    const base = `${path}/${encodeURIComponent(upload.upload_id)}`
    for (let part = 0; part < parts; part++) {
      signal?.throwIfAborted()
      if (!(upload.received ?? []).includes(part))
        await this.http.send('PUT', `${base}/${part}`, {
          signal,
          bytes: bytes.subarray(
            part * upload.part_size,
            Math.min((part + 1) * upload.part_size, bytes.length)
          ),
        })
    }
    signal?.throwIfAborted()
    await this.http.send('POST', base + '/complete', { signal })
  }
  /** Owns source until both passes and the server acknowledgement finish. */
  async putBlobSource(
    expected: ContentIdentity,
    source: ChunkSource,
    signal?: AbortSignal,
    maxChunkBytes = MAX_CHUNK_BYTES
  ): Promise<void> {
    const digest = (hash: ReturnType<typeof incrementalSha256.create>) =>
      Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const read = async (offset: number, length: number) => {
      signal?.throwIfAborted()
      const bytes = await source.read(offset, length, signal)
      signal?.throwIfAborted()
      if (bytes.length !== length || bytes.buffer.byteLength > MAX_CHUNK_BYTES)
        throw new EngineError('protocol', 'invalid source chunk length')
      return bytes
    }
    try {
      if (
        !Number.isSafeInteger(maxChunkBytes) ||
        maxChunkBytes < 1 ||
        maxChunkBytes > MAX_CHUNK_BYTES
      )
        throw new EngineError('protocol', 'invalid upload chunk size')
      if (!Number.isSafeInteger(source.size) || source.size < 0 || source.size !== expected.size)
        throw new AbeleError('hash_mismatch', 'source size changed')
      const first = incrementalSha256.create()
      for (let offset = 0; offset < source.size; offset += maxChunkBytes)
        first.update(await read(offset, Math.min(maxChunkBytes, source.size - offset)))
      if (digest(first) !== expected.sha)
        throw new AbeleError('hash_mismatch', 'source content changed')
      await source.assertUnchanged()
      signal?.throwIfAborted()
      if (await this.hasBlob(expected.sha, signal)) {
        await source.assertUnchanged()
        return
      }
      const path = `/v2/uploads/${expected.sha}`
      if (expected.size <= Math.min(maxChunkBytes, this.http.simpleUploadBytes)) {
        const bytes = expected.size === 0 ? new Uint8Array() : await read(0, expected.size)
        if ((await sha256(bytes)) !== expected.sha)
          throw new AbeleError('hash_mismatch', 'source changed during upload')
        await source.assertUnchanged()
        signal?.throwIfAborted()
        await this.http.sendChunk('PUT', path, bytes, signal)
        await source.assertUnchanged()
        return
      }
      const upload = await this.http.json(UploadBeginResponseSchema, 'POST', path + '/begin', {
        json: { size: expected.size, max_part_bytes: maxChunkBytes },
        ...(signal === undefined ? {} : { signal }),
      })
      const parts = Math.ceil(source.size / upload.part_size)
      if (
        upload.part_size > maxChunkBytes ||
        parts !== upload.parts ||
        (upload.received ?? []).some((part) => part < 0 || part >= parts)
      )
        throw new EngineError('protocol', 'invalid bounded multipart layout')
      const second = incrementalSha256.create()
      const base = `${path}/${encodeURIComponent(upload.upload_id)}`
      const received = new Set(upload.received ?? [])
      for (let part = 0; part < parts; part++) {
        const offset = part * upload.part_size
        const bytes = await read(offset, Math.min(upload.part_size, source.size - offset))
        second.update(bytes)
        if (!received.has(part)) {
          for (let attempt = 0; ; attempt++) {
            try {
              await this.http.sendChunk('PUT', `${base}/${part}`, bytes, signal)
              break
            } catch (error) {
              signal?.throwIfAborted()
              if (!(error instanceof EngineError && error.code === 'offline') || attempt >= 2)
                throw error
              if (await this.hasBlob(expected.sha, signal)) {
                await source.assertUnchanged()
                return
              }
              const resumed = await this.http.json(
                UploadBeginResponseSchema,
                'POST',
                path + '/begin',
                {
                  json: { size: expected.size, max_part_bytes: maxChunkBytes },
                  signal,
                }
              )
              if (
                resumed.upload_id !== upload.upload_id ||
                resumed.part_size !== upload.part_size ||
                resumed.parts !== parts ||
                (resumed.received ?? []).some((part) => part < 0 || part >= parts)
              )
                throw new EngineError('protocol', 'upload changed during part recovery')
              for (const accepted of resumed.received ?? []) received.add(accepted)
              if (received.has(part)) break
            }
          }
        }
      }
      if (digest(second) !== expected.sha)
        throw new AbeleError('hash_mismatch', 'source changed during upload')
      await source.assertUnchanged()
      signal?.throwIfAborted()
      await this.http.send('POST', base + '/complete', signal === undefined ? {} : { signal })
    } finally {
      await source.close()
    }
  }
  async versions(fileId: string, query: VersionsQuery = {}): Promise<VersionInfo[]> {
    return this.http.json(
      z.array(VersionInfoSchema),
      'GET',
      `/v2/files/${encodeURIComponent(fileId)}/history`,
      {
        query: { limit: query.limit, before: query.before },
      }
    )
  }
  async trash(prefix?: string): Promise<TrashItem[]> {
    return this.http.json(z.array(TrashItemSchema), 'GET', '/v2/trash', {
      query: { path_prefix: prefix },
    })
  }
  async head(fileId: string): Promise<ManifestItem> {
    const head = await this.http.json(
      ManifestItemSchema,
      'GET',
      `/v2/files/${encodeURIComponent(fileId)}/head`,
      {
        headers: { [EXTERNAL_FILES_VERSION_HEADER]: '1', 'cache-control': 'no-store' },
      }
    )
    if (head.file_id !== fileId) throw new EngineError('protocol', 'head identity mismatch')
    return head
  }
  externalFilesCapabilities() {
    return negotiateExternalFiles(
      () => this.http.json(z.unknown(), 'GET', '/v2/external-files/capabilities'),
      'token'
    )
  }
  async verifyExternalFile(fileId: string, input: ExternalVerifyRequest) {
    const expected = ExternalVerifyRequestSchema.parse(input)
    const support = await this.externalFilesCapabilities()
    if (expected.size > support.max_file_size)
      throw new AbeleError('too_large', 'external verification size bound reached')
    const response = await this.http.json(
      ExternalVerifyResponseSchema,
      'POST',
      `/v2/files/${encodeURIComponent(fileId)}/external/verify`,
      {
        json: expected,
        headers: { [EXTERNAL_FILES_VERSION_HEADER]: '1', 'cache-control': 'no-store' },
      }
    )
    return checkedExternalVerification(fileId, expected, response)
  }
  async restore(
    fileId: string,
    versionId: string,
    key = crypto.randomUUID()
  ): Promise<CommitOpResult> {
    return this.http.json(
      CommitOpResultSchema,
      'POST',
      `/v2/files/${encodeURIComponent(fileId)}/restore`,
      {
        json: { version_id: versionId },
        ...idempotency(key),
      }
    )
  }
  async restoreDeleted(fileId: string, key = crypto.randomUUID()): Promise<CommitOpResult> {
    return this.http.json(
      CommitOpResultSchema,
      'POST',
      `/v2/files/${encodeURIComponent(fileId)}/restore`,
      {
        json: { deleted: true },
        ...idempotency(key),
      }
    )
  }
  async restoreDeletedMany(
    fileIds: string[],
    key = crypto.randomUUID()
  ): Promise<CommitOpResult[]> {
    const results: CommitOpResult[] = []
    for (let at = 0, batch = 0; at < fileIds.length; at += TRASH_RESTORE_MAX, batch++) {
      const response = await this.http.json(V2CommitResponseSchema, 'POST', '/v2/trash/restore', {
        json: { file_ids: fileIds.slice(at, at + TRASH_RESTORE_MAX) },
        ...idempotency(key === undefined ? undefined : `${key}:${batch}`),
      })
      results.push(...response.results)
    }
    return results
  }
  subscribe(onSeq: (seq: number) => void, onClose: (reason: string) => void) {
    const Socket = this.http.socketClass()
    const socket = new Socket(this.http.socketUrl('/v2/events'))
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          token: this.token.key,
          ...(this.item === undefined ? {} : { item: this.item }),
        })
      )
    )
    socket.addEventListener('message', (event) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(event.data))
      } catch {
        return
      }
      const frame = V2EventSchema.safeParse(raw)
      if (!frame.success) return
      if (frame.data.type === 'changes') onSeq(frame.data.cursor)
      else onClose(frame.data.status)
    })
    socket.addEventListener('close', () => onClose('event stream closed'))
    socket.addEventListener('error', () => onClose('event stream failed'))
    return () => socket.close()
  }
}
