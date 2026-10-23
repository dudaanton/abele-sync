import { expect, it } from 'vitest'
import { encodeAccessToken } from '@abele/sync-protocol'
import { ExpectedWrites, pull, StagedChanges, V2EngineClient } from '../../src/index.js'
import { V2Directories } from '../../src/v2Directories.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

it.each(['installed', 'incoming'] as const)(
  'D-208 directory tombstone classification survives every feed/cleanup/cursor cut (%s)',
  async (known) => {
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(208)
      let state = new DurableStateStore(scheduler),
        fs = new MemoryStreamingFS(scheduler)
      const path = '.obsidian/plugins/example/assets'
      await fs.mkdir(path)
      let identity: string | undefined
      for await (const dir of fs.listDirectories()) if (dir.path === path) identity = dir.identity
      expect(identity).toBeDefined()
      const directory = {
        file_id: 'directory',
        version_id: 'v1',
        path,
        kind: 'directory',
        mtime: 1,
      }
      await state.setCursor(1)
      await state.setMeta(
        'v2-directories',
        JSON.stringify({
          directories: known === 'installed' ? [{ ...directory, identity }] : [],
          incoming: known === 'incoming' ? [directory] : [],
          removals: [],
        })
      )
      const scope = { kind: 'folder' as const, id: 'root', path: 'Root' }
      const token = encodeAccessToken({
        v: 1,
        address: 'https://example.test',
        key: 'k'.repeat(43),
        scope,
      })
      const makeClient = () =>
        new V2EngineClient(token, {
          fetch: async (url) => {
            const address = new URL(String(url))
            if (address.pathname === '/v2/connection')
              return Response.json({
                protocol: 2,
                token_id: 'token',
                space_id: 'space',
                scope,
                status: 'active',
                limits: { max_file_bytes: 10000, quota_bytes: null },
              })
            return Response.json({
              items:
                Number(address.searchParams.get('since')) < 2
                  ? [
                      {
                        type: 'delete',
                        file_id: 'directory',
                        path,
                        version_id: 'deleted',
                        cursor: 2,
                        at: '2026-01-01T00:00:00.000Z',
                      },
                    ]
                  : [],
              cursor: 2,
              next: null,
            })
          },
        })
      const run = async () => {
        const client = makeClient()
        await client.prepare(fs, state, () => false, undefined, true)
        const staged = new StagedChanges(state)
        await pull(client, fs, state, {
          expected: new ExpectedWrites(),
          dirty: new Set(),
          filter: { excluded: () => false },
          defer: () => true,
          onDefer: (items) => staged.stage(items),
        })
        expect(await staged.list()).toEqual([])
      }
      const start = scheduler.points.length
      scheduler.cut = cut
      try {
        const client = makeClient()
        await client.prepare(fs, state, () => false, undefined, true)
        await client.changes(1)
        // The identity must outlive even completed physical cleanup before ack.
        await client.finishPull()
        expect(await state.getCursor()).toBe(1)
        const dirs = new V2Directories(
          fs,
          state,
          () => true,
          async () => []
        )
        expect(await dirs.knows('directory')).toBe(true)
        await run()
      } catch (error) {
        if (!(error instanceof EpochError) || !cut) throw error
      }
      const points = scheduler.points.slice(start)
      scheduler.cut = undefined
      state = state.reopen()
      fs = fs.reopen()
      await run()
      expect(await state.getCursor()).toBe(2)
      const dirs = new V2Directories(
        fs,
        state,
        () => true,
        async () => []
      )
      expect(await dirs.knows('directory')).toBe(false)
      expect(await dirs.knows('unknown-file')).toBe(false)
      // Collection is based on the durable cursor, not physical cleanup. The
      // next directory write drops consumed markers without reviving the row.
      expect(await dirs.departed('unknown-file')).toBe(false)
      expect(JSON.parse((await state.getMeta('v2-directories'))!).tombstones).toBeUndefined()
      return points
    }
    for (const cut of await execute()) await execute(cut)
  }
)
