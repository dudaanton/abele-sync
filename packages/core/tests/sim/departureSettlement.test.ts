import { expect, it } from 'vitest'
import { encodeAccessToken } from '@abele/sync-protocol'
import { V2EngineClient, sha256 } from '../../src/index.js'
import { captureDepartures, dispatchDepartures } from '../../src/departureSettlement.js'
import { commitAppliedSettlement } from '../../src/settlement.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

it.each(['remove', 'retain', 'defer'] as const)(
  'replays departure capture, host handling and publication through every crash/recovery cut (host=%s)',
  async (mode) => {
    const retained = mode !== 'remove'
    async function execute(cut?: string, recoveryCut?: string) {
      const scheduler = new SimScheduler(7011)
      let state = new DurableStateStore(scheduler),
        fs = new MemoryStreamingFS(scheduler)
      const bytes = new Uint8Array([1]),
        path = 'Root/a.md'
      const base = {
        path,
        wirePath: path,
        fileId: 'file',
        versionId: 'v1',
        sha: await sha256(bytes),
        size: 1,
        mtime: 1,
      }
      await fs.writeAtomic(path, bytes, 1)
      await state.put(base)
      await state.setCursor(1)
      const scope = { kind: 'folder' as const, id: 'root', path: 'Root' }
      const event = {
        type: 'removal',
        file_id: 'file',
        path,
        cursor: 2,
        at: '2026-01-01T00:00:00.000Z',
      }
      let calls = 0
      let accepted = mode !== 'defer'
      const client = async () => {
        const client = new V2EngineClient(
          encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
          {
            fetch: async (url) =>
              new URL(String(url)).pathname === '/v2/connection'
                ? Response.json({
                    protocol: 2,
                    token_id: 'token',
                    space_id: 'space',
                    scope,
                    status: 'active',
                    limits: { max_file_bytes: 10000, quota_bytes: null },
                  })
                : Response.json({ items: [event], cursor: 2, next: null }),
          }
        )
        await client.prepare(fs, state, () => false, undefined, true)
        if (retained)
          client.onRemoval = async () => {
            calls++
            const row = JSON.parse(
              (await state.getMeta('settlement-departure:row:00000000000002'))!
            )
            expect(row.pending).toBe(true)
            await state.setMeta('retained-share-copy:file', JSON.stringify(base))
            await scheduler.point('host.retained')
            return accepted
          }
        return client
      }
      const attempt = async (point?: string) => {
        const current = await client()
        scheduler.cut = point
        const start = scheduler.points.length
        try {
          const page = await current.changes(1)
          await captureDepartures(state, page.departures, fs)
          await dispatchDepartures(state, current)
          await commitAppliedSettlement(
            state,
            () => ({ reached: 2, firstUnresolved: null }),
            async () => {}
          )
        } catch (error) {
          if (!(error instanceof EpochError) || !point) throw error
        }
        scheduler.cut = undefined
        return scheduler.points.slice(start)
      }
      const reopen = async () => {
        state = state.reopen()
        fs = fs.reopen()
        const raw = await state.getMeta('settlement-departure:row:00000000000002')
        const row = raw === null ? null : JSON.parse(raw)
        const resolved = row?.pending === false
        expect(await state.byFileId('file')).toEqual(resolved ? null : base)
        if ((await state.getCursor()) === 2) expect(resolved).toBe(true)
        if (retained) expect(await fs.read(path)).toEqual(bytes)
        if (resolved && retained)
          expect(await state.getMeta('retained-share-copy:file')).not.toBeNull()
      }
      const cuts = await attempt(cut)
      await reopen()
      accepted = true
      const recoveryCuts = await attempt(recoveryCut)
      await reopen()
      await attempt()
      await reopen()
      const completedCalls = calls
      await attempt()
      expect(calls).toBe(completedCalls)
      expect(await state.getCursor()).toBe(2)
      expect(await state.byFileId('file')).toBeNull()
      if (!retained) expect(await fs.stat(path)).toBeNull()
      return { cuts, recoveryCuts }
    }
    for (const cut of (await execute()).cuts) {
      const { recoveryCuts } = await execute(cut)
      for (const recoveryCut of recoveryCuts) await execute(cut, recoveryCut)
    }
  },
  60000
)
