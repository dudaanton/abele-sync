import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { encodeAccessToken, type V2Change } from '@abele/sync-protocol'
import { NodeFileSystem, SqliteStateStore } from '@abele/sync-node'
import {
  MemoryFileSystem,
  MemoryStateStore,
  SyncEngine,
  V2EngineClient,
  selectiveDefaults,
  sha256,
  type FileSystem,
  type StateStore,
} from '../../src/index.js'

for (const host of ['sim', 'native'] as const)
  it.each([false, true])(
    `D-258 resumes past 1,249 own folder echoes without folder effects (${host}, journal=%s)`,
    async (journal) => {
      await mkdir(resolve('.scratch'), { recursive: true })
      const root = await mkdtemp(resolve('.scratch/d258-'))
      const dirs = new Map<string, string>()
      const fs: FileSystem =
        host === 'native'
          ? new NodeFileSystem(root, { preserveEmptyDirectories: true })
          : Object.assign(new MemoryFileSystem(), {
              async mkdir(path: string) {
                dirs.set(path, dirs.get(path) ?? `inode:${path}`)
              },
              async *listDirectories() {
                for (const [path, identity] of dirs) yield { path, identity, mtime: 1 }
              },
            })
      const dbPath = join(root, '.abele-sync/state.db')
      let state: StateStore =
        host === 'native' ? SqliteStateStore.open(dbPath) : new MemoryStateStore()
      let engine: SyncEngine | undefined
      let events: V2Change[] = [],
        head = 1,
        firstUpload = false,
        feedRequests = 0
      let transactions = 0,
        directoryReads = 0,
        directoryWrites = 0,
        effects = 0
      let snapshot:
        { transactions: number; directoryReads: number; feedRequests: number } | undefined
      const scope = { kind: 'folder' as const, id: 'root', path: '/' }
      const token = encodeAccessToken({
        v: 1,
        address: 'https://echo.test',
        key: 'k'.repeat(43),
        scope,
      })
      const makeEngine = () => {
        const client = new V2EngineClient(token, {
          fetch: async (input, init) => {
            const url = new URL(String(input))
            if (url.pathname === '/v2/connection')
              return Response.json({
                protocol: 2,
                token_id: 'primary',
                space_id: 'space',
                scope,
                status: 'active',
                limits: { max_file_bytes: 10000000, quota_bytes: null },
              })
            if (url.pathname === '/v2/manifest')
              return Response.json({ items: [], cursor: head, next: null })
            if (url.pathname === '/v2/changes') {
              const since = Number(url.searchParams.get('since'))
              if (since === Number.MAX_SAFE_INTEGER)
                return Response.json({ items: [], cursor: head, next: null })
              feedRequests++
              const remaining = events.filter((event) => event.cursor > since)
              const items = remaining.slice(0, Number(url.searchParams.get('limit') ?? 1000))
              const cursor = items.at(-1)?.cursor ?? head
              return Response.json({
                items,
                cursor,
                next: items.length < remaining.length ? String(cursor) : null,
              })
            }
            if (init?.method === 'HEAD') return new Response(null, { status: 404 })
            if (init?.method === 'PUT' && url.pathname.startsWith('/v2/uploads/')) {
              firstUpload = true
              snapshot ??= { transactions, directoryReads, feedRequests }
              engine!.pause()
              throw new Error('test stopped at first resumed upload')
            }
            throw new Error(`unexpected request ${init?.method} ${url.pathname}`)
          },
        })
        return new SyncEngine({
          client,
          fs,
          state,
          selective: selectiveDefaults(),
          deleteGuard: false,
        })
      }
      try {
        engine = makeEngine()
        await engine.sync()
        await engine.stop()
        const count = 1249
        for (let n = 0; n < count; n++) await fs.mkdir!(`folder-${n}`)
        const identities = new Map<string, string>()
        for await (const dir of fs.listDirectories!()) identities.set(dir.path, dir.identity)
        const published = Array.from({ length: count }, (_, n) => ({
          file_id: `directory-${n}`,
          version_id: `published-${n}`,
          kind: 'directory' as const,
          path: `folder-${n}`,
          mtime: 1,
        }))
        // Durable image after the 1,249 successful single-folder commit receipts,
        // before their content events have been read. Restart loses all client caches.
        await state.setMeta!(
          'v2-directories',
          JSON.stringify({
            schemaVersion: 2,
            directories: published.map((item) => ({
              ...item,
              identity: identities.get(item.path)!,
            })),
            removals: [],
          })
        )
        events = published.map((item, n) => ({
          type: 'content',
          file_id: item.file_id,
          path: item.path,
          item,
          prev_path: null,
          cursor: n + 2,
          at: '2026-01-01T00:00:00.000Z',
        }))
        head = count + 1
        const bytes = new Uint8Array([1, 2, 3])
        await fs.writeAtomic('upload.bin', bytes, 1)
        if (journal)
          await state.setJournal({
            batchId: 'interrupted',
            idempotencyKey: 'original-upload',
            startedAt: new Date().toISOString(),
            ops: [
              {
                op: 'create',
                path: 'upload.bin',
                sha: await sha256(bytes),
                size: bytes.length,
                mtime: 1,
              },
            ],
          })
        if (state instanceof SqliteStateStore) {
          state.close()
          state = SqliteStateStore.open(dbPath)
        }
        const originalMkdir = fs.mkdir!.bind(fs)
        vi.spyOn(fs, 'mkdir').mockImplementation(async (path) => {
          if (identities.has(path)) {
            effects++
            throw new Error('own directory echo attempted mkdir')
          }
          await originalMkdir(path)
        })
        for (const method of ['moveDirectory', 'removeDirectory'] as const)
          if (fs[method])
            vi.spyOn(fs, method).mockImplementation(async () => {
              effects++
              throw new Error(`own directory echo attempted ${method}`)
            })
        const transaction = state.transaction.bind(state)
        vi.spyOn(state, 'transaction').mockImplementation(async (fn) => {
          transactions++
          return transaction(fn)
        })
        const getMeta = state.getMeta!.bind(state)
        vi.spyOn(state, 'getMeta').mockImplementation(async (key) => {
          if (key === 'v2-directories') directoryReads++
          return getMeta(key)
        })
        const setMeta = state.setMeta!.bind(state)
        vi.spyOn(state, 'setMeta').mockImplementation(async (key, value) => {
          if (key === 'v2-directories') directoryWrites++
          await setMeta(key, value)
        })
        feedRequests = 0
        engine = makeEngine()
        const start = performance.now()
        await engine.sync().catch(() => undefined)
        console.info({
          host,
          journal,
          firstUploadMs: performance.now() - start,
          snapshot,
          directoryWrites,
          effects,
        })
        expect(effects).toBe(0)
        expect(firstUpload).toBe(true)
        expect(snapshot!.transactions).toBeLessThanOrEqual(24)
        expect(snapshot!.directoryReads).toBeLessThanOrEqual(32)
        expect(directoryWrites).toBeLessThanOrEqual(2)
        expect(snapshot!.feedRequests).toBe(journal ? 0 : 2)
      } finally {
        await engine?.stop()
        vi.restoreAllMocks()
        if (state instanceof SqliteStateStore) state.close()
        await rm(root, { recursive: true, force: true })
      }
    },
    120000
  )
