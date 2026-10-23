import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, V2EngineClient } from '../../src/index.js'
import { captureDepartures, dispatchDepartures } from '../../src/departureSettlement.js'
import { firstSettlementSequence } from '../../src/settlementIndex.js'

it('captures and settles 33k departures with linear persistence and bounded indexed scheduling', async () => {
  const count = 33000
  const state = new MemoryStateStore(),
    fs = new MemoryFileSystem()
  const scope = { kind: 'folder' as const, id: 'root', path: 'Root' }
  const items = Array.from({ length: count }, (_, n) => ({
    type: 'removal' as const,
    file_id: `f${n}`,
    path: `Root/${n}.md`,
    cursor: n + 1,
    at: '2026-01-01T00:00:00.000Z',
  }))
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
          : Response.json({ items, cursor: count, next: null }),
    }
  )
  await client.prepare(fs, state, () => false, undefined, true)
  let calls = 0,
    writes = 0,
    bytes = 0
  client.onRemoval = async () => {
    calls++
    return true
  }
  const transaction = state.transaction.bind(state)
  state.transaction = (work) =>
    transaction(async (tx) => {
      const setMeta = tx.setMeta!.bind(tx)
      tx.setMeta = async (key, value) => {
        writes++
        bytes += key.length + (value?.length ?? 0)
        if (writes > count * 12 || bytes > count * 2500)
          throw new Error('nonlinear departure persistence')
        await setMeta(key, value)
      }
      return work(tx)
    })
  const page = await client.changes(0)
  await captureDepartures(state, page.departures, fs)
  expect(await firstSettlementSequence(state)).toBe(1)
  state.metadataKeys = () => {
    throw new Error('unbounded scheduling enumeration')
  }
  await dispatchDepartures(state, client)
  expect(calls).toBe(1000)
  expect(await firstSettlementSequence(state)).toBe(1001)
  while (calls < count) await dispatchDepartures(state, client)
  expect(await firstSettlementSequence(state)).toBeNull()
  expect(writes).toBeLessThanOrEqual(count * 12)
  expect(bytes).toBeLessThanOrEqual(count * 2500)
}, 30000)
