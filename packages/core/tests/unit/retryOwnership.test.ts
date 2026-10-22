import { afterEach, expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { StateTransaction } from '../../src/stateTransaction.js'
import { FileRetries } from '../../src/fileRetry.js'
import { resumeReceipts } from '../../src/pusher.js'
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

it('D-147 a crash removing the schedule rolls back receipt retirement too', async () => {
  const f = await fixture()
  const root = f.state.setMeta.bind(f.state),
    scoped = StateTransaction.prototype.setMeta
  const fail = (key: string, value: string | null) => {
    if (key.startsWith('file-retry:') && value === null)
      throw new Error('crash at schedule retirement')
  }
  f.state.setMeta = async (key, value) => {
    fail(key, value)
    await root(key, value)
  }
  vi.spyOn(StateTransaction.prototype, 'setMeta').mockImplementation(async function (
    this: StateTransaction,
    key,
    value
  ) {
    fail(key, value)
    await scoped.call(this, key, value)
  })
  await expect(f.run()).rejects.toThrow('crash at schedule retirement')
  expect(await f.state.getMeta(f.key)).not.toBeNull()
  expect(await f.state.getMeta('file-retry:old.bin')).not.toBeNull()
})

it('D-147 sweeps an old ownerless recovery schedule on startup and never schedules it', async () => {
  const f = await fixture()
  await f.state.setMeta(f.key, null)
  expect(await f.retries.next()).toBeNull()
  await f.retries.load()
  expect(f.retries.list()).toEqual([])
  expect(await f.state.getMeta('file-retry:old.bin')).toBeNull()
})
