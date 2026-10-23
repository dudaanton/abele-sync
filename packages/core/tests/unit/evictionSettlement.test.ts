import { expect, it } from 'vitest'
import { MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'
import { evictionKey, recoverPullEvictions } from '../../src/pullEvictions.js'
import { FileRetries } from '../../src/fileRetry.js'

async function fixture() {
  const fs = new MemoryFileSystem({ caseInsensitive: true, normalizing: true })
  const state = new MemoryStateStore()
  const base = {
    path: 'Café.md',
    wirePath: 'Café.md',
    fileId: 'victim',
    versionId: 'v1',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  }
  await state.put(base)
  await state.setCursor(1)
  const key = evictionKey(base.fileId)
  const raw = JSON.stringify(base)
  await state.setMeta(key, raw)
  let now = 0
  const retries = new FileRetries(
    state,
    () => now,
    () => {}
  )
  await retries.failed(base.wirePath, 'recovery', new Error('pending'), false, state, key)
  await retries.failed(key, 'recovery', new Error('pending'), false, state, key)
  now = 10000
  return { fs, state, base, key, raw, retries }
}

it.each(['identity', 'version', 'case', 'unicode'])(
  'retains eviction evidence and retries when the %s owner changes before settlement',
  async (kind) => {
    const f = await fixture()
    const newer = {
      ...f.base,
      fileId: kind === 'version' ? f.base.fileId : 'other',
      versionId: 'v2',
      path: kind === 'case' ? 'CAFÉ.md' : kind === 'unicode' ? 'Café.md' : f.base.path,
    }
    const transaction = f.state.transaction.bind(f.state)
    f.state.transaction = async (work) => {
      await f.state.put(newer)
      return transaction(work)
    }
    await recoverPullEvictions(f.fs, f.state, undefined, f.retries)
    expect(await f.state.get(newer.path)).toEqual(newer)
    expect(await f.state.getMeta(f.key)).toBe(f.raw)
    expect(f.retries.list()).toHaveLength(2)
  }
)

it('does not consume a replacement eviction intent under the same metadata key', async () => {
  const f = await fixture()
  const newer = JSON.stringify({ ...f.base, versionId: 'v2' })
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = async (work) => {
    await f.state.setMeta(f.key, newer)
    return transaction(work)
  }
  await recoverPullEvictions(f.fs, f.state, undefined, f.retries)
  expect(await f.state.getMeta(f.key)).toBe(newer)
  expect(await f.state.get(f.base.path)).toEqual(f.base)
  expect(f.retries.list()).toHaveLength(2)
})

it('rechecks absence after entering eviction publication', async () => {
  const f = await fixture()
  const bytes = new Uint8Array([9])
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = async (work) => {
    await f.fs.writeAtomic(f.base.path, bytes, 1)
    return transaction(work)
  }
  await recoverPullEvictions(f.fs, f.state, undefined, f.retries)
  expect(await f.state.get(f.base.path)).toEqual(f.base)
  expect(await f.state.getMeta(f.key)).toBe(f.raw)
  expect(await f.fs.read(f.base.path)).toEqual(bytes)
  expect(f.retries.list()).toHaveLength(2)
})

it('rechecks a directory refusal at eviction publication', async () => {
  const f = await fixture()
  let blocked = false
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = async (work) => {
    blocked = true
    return transaction(work)
  }
  await recoverPullEvictions(f.fs, f.state, undefined, f.retries, {
    pathRefusal: () =>
      blocked
        ? {
            path: f.base.path,
            code: 'conflict',
            message: 'held',
            direction: 'pull',
            evidence: true,
          }
        : undefined,
  })
  expect(await f.state.get(f.base.path)).toEqual(f.base)
  expect(await f.state.getMeta(f.key)).toBe(f.raw)
  expect(f.retries.list()).toHaveLength(2)
})

it('commits eviction evidence, ledger, retry retirement and frontier together', async () => {
  const f = await fixture()
  const waiting = f.retries.list()
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = (work) =>
    transaction(async (tx) => {
      tx.setCursor = async () => {
        throw new Error('frontier failed')
      }
      return work(tx)
    })
  await expect(recoverPullEvictions(f.fs, f.state, undefined, f.retries)).rejects.toThrow(
    'frontier failed'
  )
  expect(await f.state.get(f.base.path)).toEqual(f.base)
  expect(await f.state.getMeta(f.key)).toBe(f.raw)
  expect(f.retries.list()).toEqual(waiting)
  const reopened = new FileRetries(
    f.state,
    () => 10000,
    () => {}
  )
  await reopened.load()
  expect(reopened.list()).toEqual(waiting)
  f.state.transaction = transaction
  await recoverPullEvictions(f.fs, f.state, undefined, f.retries)
  expect(await f.state.get(f.base.path)).toBeNull()
  expect(await f.state.getMeta(f.key)).toBeNull()
  expect(f.retries.list()).toEqual([])
  expect(await f.state.getCursor()).toBe(1)
})

it('does not retire a recovery retry owned by another operation at the victim path', async () => {
  const f = await fixture()
  const other = {
    ...f.retries.list().find((row) => row.path === f.base.wirePath)!,
    owner: 'pull-write:other',
    nextAt: 0,
  }
  await f.state.setMeta(other.owner, JSON.stringify({ base: f.base }))
  const retryKey = 'file-retry:' + encodeURIComponent(f.base.wirePath)
  await f.state.setMeta(retryKey, JSON.stringify(other))
  await f.retries.load()
  await recoverPullEvictions(f.fs, f.state, undefined, f.retries)
  expect(await f.state.getMeta(f.key)).toBeNull()
  expect(await f.state.getMeta(other.owner)).not.toBeNull()
  expect(await f.state.getMeta(retryKey)).toBe(JSON.stringify(other))
  expect(f.retries.list()).toEqual([other])
})
