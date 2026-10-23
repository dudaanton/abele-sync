import { encodeAccessToken } from '@abele/sync-protocol'
import { expect, it, vi } from 'vitest'
import { V2EngineClient, MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'
import { captureDepartures, dispatchDepartures } from '../../src/departureSettlement.js'
import { firstSettlementSequence } from '../../src/settlementIndex.js'
import { commitAppliedSettlement } from '../../src/settlement.js'
import { FileRetries } from '../../src/fileRetry.js'

async function fixture(
  pageEvents?: (base: import('../../src/state.js').StateEntry) => unknown[],
  path = 'Root.md'
) {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = new Uint8Array([1]),
    edit = new Uint8Array([3])
  await fs.writeAtomic(path, original, 1)
  const base = {
    path: path,
    wirePath: path,
    fileId: 'root',
    versionId: 'a',
    sha: await sha256(original),
    size: 1,
    mtime: 1,
  }
  await state.put(base)
  const scope = { kind: 'group' as const, id: 'root', path: path }
  const client = new V2EngineClient(
    encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
    {
      fetch: async (url) => {
        if (new URL(String(url)).pathname === '/v2/connection')
          return Response.json({
            protocol: 2,
            token_id: 'token',
            space_id: 'space',
            scope,
            status: 'active',
            limits: { max_file_bytes: 10000, quota_bytes: null },
          })
        return Response.json({
          items: pageEvents?.(base) ?? [
            {
              type: 'removal',
              file_id: 'root',
              path: path,
              cursor: 2,
              at: '2026-01-01T00:00:00.000Z',
            },
          ],
          next: null,
          cursor: 2,
        })
      },
    }
  )
  await client.prepare(fs, state, () => false, undefined, true)
  return { fs, state, client, base, original, edit }
}

it('V2 removal refuses a save at the filesystem effect boundary and retains its base', async () => {
  const { fs, state, client, base, edit } = await fixture()
  let injected = false
  const remove = fs.remove.bind(fs),
    conditional = fs.conditionalFile.bind(fs)
  fs.remove = async (path) => {
    injected = true
    await fs.writeAtomic(path, edit, 1)
    await remove(path)
  }
  fs.conditionalFile = async (op) => {
    injected = true
    await fs.writeAtomic(op.path, edit, 1)
    return conditional(op)
  }
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  await dispatchDepartures(state, client)
  expect(injected).toBe(true)
  expect(await fs.read('Root.md')).toEqual(edit)
  expect(await state.get('Root.md')).toEqual(base)
})

it('decodes a versionless departure without host, filesystem or ledger effects', async () => {
  const { fs, state, client, base, original } = await fixture()
  const host = vi.fn(async () => true)
  client.onRemoval = host
  const write = vi.spyOn(state, 'setMeta')
  const page = await client.changes(1)
  expect(page.next_since).toBe(2)
  expect(host).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
})

it('retains captured source authority when equal bytes are replaced before dispatch', async () => {
  const { fs, state, client, base, original } = await fixture()
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  await fs.remove(base.path)
  await fs.writeAtomic(base.path, original, base.mtime)
  await dispatchDepartures(state, client)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
  expect(await firstSettlementSequence(state)).toBe(2)
})

it('pause after an issued host callback retains its obligation without ledger publication', async () => {
  const { fs, state, client, base, original } = await fixture()
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  const stop = new AbortController()
  client.onRemoval = async () => {
    stop.abort()
    return true
  }
  await expect(dispatchDepartures(state, client, stop.signal)).rejects.toThrow()
  expect(await firstSettlementSequence(state)).toBe(2)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
})

it('preserves a file recreated after capturing an absent departure source, even with equal bytes', async () => {
  const { fs, state, client, base, original } = await fixture()
  await fs.remove(base.path)
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  await fs.writeAtomic(base.path, original, base.mtime)
  const host = vi.fn(async () => true)
  client.onRemoval = host
  await dispatchDepartures(state, client)
  expect(host).not.toHaveBeenCalled()
  expect(await firstSettlementSequence(state)).toBe(2)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
})

it('conditions removal on observed absence when recreation races the effect', async () => {
  const { fs, state, client, base, original } = await fixture()
  await fs.remove(base.path)
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  const conditional = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (op) => {
    await fs.writeAtomic(base.path, original, base.mtime)
    return conditional(op)
  }
  await dispatchDepartures(state, client)
  expect(await firstSettlementSequence(state)).toBe(2)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
})

it('preserves malformed departure evidence without invoking the host', async () => {
  const { fs, state, client } = await fixture()
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  const key = 'settlement-departure:row:00000000000002'
  await state.setMeta(key, '{broken')
  const host = vi.fn(async () => true)
  client.onRemoval = host
  await expect(dispatchDepartures(state, client)).rejects.toThrow()
  expect(await state.getMeta(key)).toBe('{broken')
  expect(await firstSettlementSequence(state)).toBe(2)
  expect(host).not.toHaveBeenCalled()
})

it.each(['exact', 'case', 'unicode'] as const)(
  'a newer %s physical owner blocks host and ledger departure',
  async (alias) => {
    const { fs, state, client, base, original } = await fixture(
      undefined,
      alias === 'unicode' ? 'Róot.md' : 'Root.md'
    )
    const page = await client.changes(1)
    await captureDepartures(state, page.departures, fs)
    const path = alias === 'exact' ? base.path : alias === 'case' ? 'ROOT.md' : 'Róot.md'
    fs.pathKey = (path) => path.normalize('NFC').toLowerCase()
    const foreign = {
      ...base,
      fileId: 'foreign',
      versionId: 'foreign-version',
      path,
      wirePath: path.normalize('NFC'),
    }
    await state.put(foreign)
    const host = vi.fn(async () => true)
    client.onRemoval = host
    await dispatchDepartures(state, client)
    expect(host).not.toHaveBeenCalled()
    expect(await state.get(path)).toEqual(foreign)
    expect(await fs.read(base.path)).toEqual(original)
    expect(await firstSettlementSequence(state)).toBe(2)
  }
)

it('captures before the host callback and retries false without retiring source or advancing cursor', async () => {
  const { fs, state, client, base, original } = await fixture()
  await state.setCursor(1)
  let accepted = false
  const host = vi.fn(async () => {
    expect(await firstSettlementSequence(state)).toBe(2)
    return accepted
  })
  client.onRemoval = host
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  await dispatchDepartures(state, client)
  expect(host).toHaveBeenCalledTimes(1)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
  await commitAppliedSettlement(
    state,
    () => ({ reached: 8, firstUnresolved: null }),
    async () => {}
  )
  expect(await state.getCursor()).toBe(1)
  accepted = true
  await dispatchDepartures(state, client)
  expect(host).toHaveBeenCalledTimes(2)
  expect(await state.get(base.path)).toBeNull()
  expect(await fs.read(base.path)).toEqual(original)
  expect(await firstSettlementSequence(state)).toBeNull()
  await captureDepartures(state, page.departures, fs)
  await dispatchDepartures(state, client)
  expect(host).toHaveBeenCalledTimes(2)
})

it('schedules a false host acknowledgement without letting file success retire its owner', async () => {
  const { fs, state, client, base } = await fixture()
  let now = 1000,
    accepted = false
  let retries = new FileRetries(
    state,
    () => now,
    () => {}
  )
  const host = vi.fn(async () => accepted)
  client.onRemoval = host
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  await dispatchDepartures(state, client, undefined, 1000, retries)
  await dispatchDepartures(state, client, undefined, 1000, retries)
  expect(host).toHaveBeenCalledTimes(1)
  expect(retries.list()).toMatchObject([
    { path: base.path, phase: 'departure', attempts: 1, nextAt: 6000 },
  ])
  await retries.succeeded(base.path, 'pull')
  expect(retries.has(base.path)).toBe(true)
  retries = new FileRetries(
    state,
    () => now,
    () => {}
  )
  await retries.load()
  expect(await retries.next()).toBe(6000)
  now = 6000
  accepted = true
  await dispatchDepartures(state, client, undefined, 1000, retries)
  expect(host).toHaveBeenCalledTimes(2)
  expect(retries.list()).toEqual([])
  expect(await firstSettlementSequence(state)).toBeNull()
})

it('does not schedule an obsolete false answer after another dispatcher commits the owner', async () => {
  const { fs, state, client } = await fixture()
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  const retries = new FileRetries(
    state,
    () => 1000,
    () => {}
  )
  let entered!: () => void,
    release!: () => void,
    calls = 0
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  client.onRemoval = async () => {
    if (++calls > 1) return true
    entered()
    await waiting
    return false
  }
  const first = dispatchDepartures(state, client, undefined, 1000, retries)
  await started
  await dispatchDepartures(state, client, undefined, 1000, retries)
  release()
  await first
  expect(await firstSettlementSequence(state)).toBeNull()
  expect(retries.list()).toEqual([])
})

it.each(['before', 'during'] as const)(
  'never uses host acknowledgement to override a hold installed %s callback',
  async (when) => {
    const { fs, state, client, base, original } = await fixture()
    const hold = () =>
      state.setMeta(
        'v2-directories',
        JSON.stringify({
          directories: [],
          removals: [],
          refused: [{ path: base.path, direction: 'push', code: 'conflict', message: 'held' }],
        })
      )
    const host = vi.fn(async () => {
      await hold()
      return true
    })
    client.onRemoval = host
    const page = await client.changes(1)
    await captureDepartures(state, page.departures, fs)
    if (when === 'before') await hold()
    await dispatchDepartures(state, client)
    expect(host).toHaveBeenCalledTimes(when === 'before' ? 0 : 1)
    expect(await state.get(base.path)).toEqual(base)
    expect(await fs.read(base.path)).toEqual(original)
    expect(await firstSettlementSequence(state)).toBe(2)
  }
)

it('does not accept a later removal as membership proof when replaying durable evidence', async () => {
  const { fs, state, client, base, original } = await fixture()
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  const corrupt = JSON.stringify({
    connection: 'token',
    generation: null,
    event: { ...page.departures[0]!.event, cursor: 3 },
  })
  await state.setMeta('settlement-membership:root', corrupt)
  const host = vi.fn(async () => true)
  client.onRemoval = host
  await expect(dispatchDepartures(state, client)).rejects.toThrow()
  expect(host).not.toHaveBeenCalled()
  expect(await firstSettlementSequence(state)).toBe(2)
  expect(await state.getMeta('settlement-membership:root')).toBe(corrupt)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
})

it('a later rejoin in the same page supersedes departure without deleting the current copy', async () => {
  const { fs, state, client, base, original } = await fixture((base) => [
    {
      type: 'removal',
      file_id: base.fileId,
      path: base.path,
      cursor: 2,
      at: '2026-01-01T00:00:00.000Z',
    },
    {
      type: 'content',
      file_id: base.fileId,
      path: base.path,
      cursor: 3,
      at: '2026-01-01T00:00:00.000Z',
      prev_path: null,
      item: {
        file_id: base.fileId,
        version_id: 'rejoined',
        path: base.path,
        sha: base.sha,
        size: base.size,
        mtime: base.mtime,
        kind: 'note',
      },
    },
  ])
  const page = await client.changes(1)
  await captureDepartures(state, page.departures, fs)
  await dispatchDepartures(state, client)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(original)
  expect(client.includes(base.path)).toBe(true)
  expect(await firstSettlementSequence(state)).toBeNull()
})
