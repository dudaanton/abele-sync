import { afterEach, expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { StateTransaction } from '../../src/stateTransaction.js'
import { FileRetries } from '../../src/fileRetry.js'
import { resumeReceipts, resumeJournal } from '../../src/pusher.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { stoppableFileEffects } from '../../src/guard.js'
import { SyncCancelled } from '../../src/cancellation.js'
import type { EngineClient } from '../../src/engineClient.js'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const op = { op: 'create' as const, path: 'old.bin', sha, size: 1, mtime: 1 }
  const result = { ...op, status: 'applied' as const, file_id: 'file', version_id: 'v1', seq: 1 }
  const key = 'push-receipt:file'
  await fs.writeAtomic('old.bin', bytes, 1)
  await state.setMeta(key, JSON.stringify({ path: op.path, op, result }))
  const retries = new FileRetries(
    state,
    () => 10000,
    () => {}
  )
  await retries.failed(op.path, 'recovery', new Error('retry receipt'))
  await retries.retryNow()
  const client = { getBlob: vi.fn(async () => bytes) } as unknown as EngineClient
  const run = () => resumeReceipts(client, fs, state, { expected: new ExpectedWrites(), retries })
  return { fs, state, bytes, sha, op, result, key, retries, client, run }
}

it.each(['legacy', 'bound'] as const)(
  'D-146 does not replay a %s receipt over a later rename',
  async (format) => {
    const f = await fixture()
    if (format === 'bound')
      await f.state.setMeta(
        f.key,
        JSON.stringify({ path: 'old.bin', op: f.op, result: f.result, base: null })
      )
    await f.fs.move('old.bin', 'new.bin')
    const advanced = {
      path: 'new.bin',
      wirePath: 'new.bin',
      fileId: 'file',
      versionId: 'v2',
      sha: f.sha,
      size: 1,
      mtime: 1,
    }
    await f.state.put(advanced)
    await f.state.setCursor(2)
    await f.run()
    expect(await f.fs.stat('old.bin')).toBeNull()
    expect(await f.fs.read('new.bin')).toEqual(f.bytes)
    expect(await f.state.byFileId('file')).toEqual(advanced)
    expect(await f.state.getCursor()).toBe(2)
    expect(await f.state.getMeta(f.key)).toBeNull()
    expect(f.client.getBlob).not.toHaveBeenCalled()
  }
)

it('D-146 does not resurrect a create receipt after a later deletion', async () => {
  const f = await fixture()
  await f.fs.remove('old.bin')
  await f.state.setCursor(2)
  await f.run()
  expect(await f.fs.stat('old.bin')).toBeNull()
  expect(await f.state.byFileId('file')).toBeNull()
  expect(await f.state.getMeta(f.key)).toBeNull()
})

it('D-146 journal answer replay also preserves an identity advanced by a later rename', async () => {
  const f = await fixture()
  await f.state.setMeta(f.key, null)
  await f.fs.move('old.bin', 'new.bin')
  const advanced = {
    path: 'new.bin',
    wirePath: 'new.bin',
    fileId: 'file',
    versionId: 'v2',
    sha: f.sha,
    size: 1,
    mtime: 1,
  }
  await f.state.put(advanced)
  await f.state.setCursor(2)
  await f.state.setJournal({
    ops: [f.op],
    idempotencyKey: 'original',
    batchId: 'batch',
    startedAt: new Date().toISOString(),
  })
  f.client.hasBlob = async () => true
  f.client.commitRaw = vi.fn(async () => ({
    replayed: true,
    body: { head_seq: 2, results: [f.result] },
  }))
  await resumeJournal(f.client, f.fs, f.state, {
    expected: new ExpectedWrites(),
    retries: f.retries,
  })
  expect(await f.fs.stat('old.bin')).toBeNull()
  expect(await f.state.byFileId('file')).toEqual(advanced)
  expect(await f.state.getJournal()).toBeNull()
  expect(f.client.commitRaw).toHaveBeenCalledWith([f.op], 'original')
})
