import { afterEach, expect, it, vi } from 'vitest'
import { StateTransaction } from '../src/stateTransaction.js'
import { MemoryStateStore } from '../src/state.js'
import { GENERATION_KEY, MEMBERS_KEY, reconcileGeneration } from '../src/restoreGeneration.js'
import { Http } from '../src/http.js'

afterEach(() => vi.restoreAllMocks())

it('archives untracked pull intents on first contact and atomically retires all pull authority', async () => {
  const state = new MemoryStateStore()
  const raw = JSON.stringify({ base: null, stageId: 'retain-staged-bytes' })
  await state.setMeta('pull-write:new-file', raw)
  expect(await reconcileGeneration(state, 'first')).toBe(true)
  expect(await state.getMeta('pull-write:new-file')).toBeNull()
  expect(
    JSON.parse((await state.getMeta('retired-generation:legacy'))!).metadata['pull-write:new-file']
  ).toBe(raw)
  await state.setMeta('pull-write:other-file', raw)
  const save = StateTransaction.prototype.setMeta
  vi.spyOn(StateTransaction.prototype, 'setMeta').mockImplementation(async function (
    this: StateTransaction,
    key,
    value
  ) {
    if (key === GENERATION_KEY) throw new Error('disk full at generation fence')
    await save.call(this, key, value)
  })
  await expect(reconcileGeneration(state, 'second')).rejects.toThrow(
    'disk full at generation fence'
  )
  expect(await state.getMeta('pull-write:other-file')).toBe(raw)
  expect(await state.getMeta('retired-generation:first')).toBeNull()
  expect(await state.getMeta(GENERATION_KEY)).toBe('first')
})

it('restore retires ledger entries using their physical spelling, including NFD paths', async () => {
  const state = new MemoryStateStore()
  await reconcileGeneration(state, 'old')
  await state.put({
    path: 'Cafe\u0301.md',
    wirePath: 'Café.md',
    fileId: 'f',
    versionId: 'v',
    sha: 'a'.repeat(64),
    size: 1,
    mtime: 1,
  })
  await reconcileGeneration(state, 'new')
  const entries = []
  for await (const entry of state.all()) entries.push(entry)
  expect(entries).toEqual([])
  expect(await state.byFileId('f')).toBeNull()
})

it('a second server restore during recovery retains the prior shared membership evidence', async () => {
  const state = new MemoryStateStore()
  await reconcileGeneration(state, 'first')
  const entry = {
    path: 'Shared.png',
    wirePath: 'Shared.png',
    fileId: 'file',
    versionId: 'version',
    sha: 'a'.repeat(64),
    size: 1,
    mtime: 1,
  }
  await state.put(entry)
  await reconcileGeneration(state, 'second')
  await reconcileGeneration(state, 'third')
  expect(JSON.parse((await state.getMeta(MEMBERS_KEY))!)).toEqual([entry])
})

it('missing generation keeps legacy cursor and journal behavior; first generation fences an existing ledger', async () => {
  const state = new MemoryStateStore()
  const journal = { batchId: 'b', ops: [], idempotencyKey: 'receipt', startedAt: 'now' }
  await state.setCursor(42)
  await state.setJournal(journal)
  expect(await reconcileGeneration(state, undefined)).toBe(false)
  expect(await state.getCursor()).toBe(42)
  expect(await state.getJournal()).toEqual(journal)
  expect(await reconcileGeneration(state, 'new')).toBe(true)
  expect(await state.getJournal()).toBeNull()
  expect(await state.getCursor()).toBe(0)
  expect(JSON.parse((await state.getMeta('retired-generation:legacy'))!).journal).toEqual(journal)
  expect(await state.getMeta(GENERATION_KEY)).toBe('new')
  await state.setCursor(7)
  expect(await reconcileGeneration(state, 'new')).toBe(false)
  expect(await state.getCursor()).toBe(7)
})

it('generation reset rolls back together if any durable write fails', async () => {
  const state = new MemoryStateStore()
  await reconcileGeneration(state, 'old')
  await state.setCursor(42)
  const set = StateTransaction.prototype.setCursor
  vi.spyOn(StateTransaction.prototype, 'setCursor').mockImplementation(async function (
    this: StateTransaction,
    seq
  ) {
    if (seq === 0) throw new Error('disk full')
    await set.call(this, seq)
  })
  await expect(reconcileGeneration(state, 'new')).rejects.toThrow('disk full')
  expect(await state.getCursor()).toBe(42)
  expect(await state.getMeta(GENERATION_KEY)).toBe('old')
  expect(await state.getMeta('retired-generation:old')).toBeNull()
})

it('transport fences a changed response before consumers decode or apply it, and sends the pinned generation', async () => {
  let sent: Headers | undefined
  const http = new Http({
    baseUrl: 'http://localhost',
    token: 'synthetic',
    fetch: async (_input, init) => {
      sent = new Headers(init?.headers)
      return new Response('{}', { headers: { 'abele-restore-generation': 'new' } })
    },
  })
  http.generation = 'old'
  await expect(http.send('POST', '/v2/commit', { json: { ops: [] } })).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(sent!.get('abele-restore-generation')).toBe('old')
  http.generation = undefined
  await expect(http.send('GET', '/v2/connection')).resolves.toBeInstanceOf(Response)
})
