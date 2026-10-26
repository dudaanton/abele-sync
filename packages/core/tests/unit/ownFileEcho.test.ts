import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { encodeAccessToken } from '@abele/sync-protocol'
import { NodeFileSystem, SqliteStateStore } from '@abele/sync-node'
import {
  MemoryFileSystem,
  MemoryStateStore,
  V2EngineClient,
  sha256,
  type FileSystem,
  type StateStore,
} from '../../src/index.js'
import { pull } from '../../src/puller.js'
import { ExpectedWrites } from '../../src/echo.js'

for (const host of ['sim', 'native'] as const)
  it(`settles 1,249 file echoes in page batches without filesystem effects (${host})`, async () => {
    await mkdir(resolve('.scratch'), { recursive: true })
    const root = await mkdtemp(resolve('.scratch/d258-files-'))
    const fs: FileSystem = host === 'native' ? new NodeFileSystem(root) : new MemoryFileSystem()
    const state: StateStore =
      host === 'native'
        ? SqliteStateStore.open(join(root, '.abele-sync/state.db'))
        : new MemoryStateStore()
    try {
      const count = 1249,
        sha = await sha256(new Uint8Array([1]))
      const items = Array.from({ length: count }, (_, n) => ({
        file_id: `file-${n}`,
        version_id: `own-${n}`,
        path: `file-${n}.bin`,
        kind: 'attachment' as const,
        sha,
        size: 1,
        mtime: 1,
      }))
      // Local files may have been deleted offline after publication. An echo
      // cannot repair that local intent or cause another installation.
      await state.transaction(async (tx) => {
        await tx.setCursor(1)
        for (const item of items)
          await tx.put({
            path: item.path,
            wirePath: item.path,
            fileId: item.file_id,
            versionId: item.version_id,
            sha,
            size: 1,
            mtime: 1,
          })
      })
      const scope = { kind: 'folder' as const, id: 'root', path: '/' }
      const client = new V2EngineClient(
        encodeAccessToken({ v: 1, address: 'https://echo.test', key: 'k'.repeat(43), scope }),
        {
          fetch: async (input) => {
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
            if (url.pathname !== '/v2/changes') throw new Error('file echo attempted download')
            const since = Number(url.searchParams.get('since'))
            const remaining = items.filter((_, n) => n + 2 > since)
            const page = remaining.slice(0, Number(url.searchParams.get('limit') ?? 1000))
            const events = page.map((item) => ({
              type: 'content',
              item,
              file_id: item.file_id,
              path: item.path,
              cursor: Number(item.file_id.slice(5)) + 2,
              prev_path: null,
              at: '2026-01-01T00:00:00.000Z',
            }))
            return Response.json({
              items: events,
              cursor: events.at(-1)?.cursor ?? count + 1,
              next: page.length < remaining.length ? String(events.at(-1)!.cursor) : null,
            })
          },
        }
      )
      await client.prepare(fs, state, () => false, undefined, true)
      let transactions = 0,
        effects = 0
      const original = state.transaction.bind(state)
      vi.spyOn(state, 'transaction').mockImplementation(async (fn) => {
        transactions++
        return original(fn)
      })
      const blocked = async () => {
        effects++
        throw new Error('file echo attempted filesystem effect')
      }
      Object.assign(fs, {
        writeAtomic: blocked,
        move: blocked,
        remove: blocked,
        conditionalFile: blocked,
        beginAtomicWrite: blocked,
        mkdir: blocked,
      })
      const result = await pull(client, fs, state, {
        filter: { excluded: () => false },
        dirty: new Set(),
        expected: new ExpectedWrites(),
      })
      expect(result.cursor).toBe(count + 1)
      expect(result.skipped).toBe(count)
      expect(result.applied).toBe(0)
      expect(effects).toBe(0)
      expect(transactions).toBeLessThanOrEqual(8)
    } finally {
      vi.restoreAllMocks()
      if (state instanceof SqliteStateStore) state.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)
