import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { V2Directories } from '../../src/v2Directories.js'

it('indexes 33k paths and 3k folders with bounded work and host checkpoints', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const count = 3000,
    files = 33000
  const dirs = Array.from({ length: count }, (_, n) => ({
    path: `folder${n}`,
    identity: `i${n}`,
    mtime: 1,
  }))
  fs.listDirectories = async function* () {
    yield* dirs
  }
  fs.list = async function* () {
    for (let n = 0; n < files; n++) yield { path: `folder${n % count}/file${n}`, size: 1, mtime: 1 }
  }
  for (let n = 0; n < files; n++) {
    const path = `folder${n % count}/file${n}`
    await state.put({
      path,
      wirePath: path,
      fileId: `f${n}`,
      versionId: 'v1',
      sha: '0'.repeat(64),
      size: 1,
      mtime: 1,
    })
  }
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: dirs.map((d) => ({
        ...d,
        kind: 'directory',
        file_id: d.identity,
        version_id: 'v1',
      })),
      removals: [],
    })
  )
  const commit = vi.fn()
  const normalize = String.prototype.normalize
  let operations = 0,
    ticks = 0,
    longest = 0,
    last = performance.now()
  String.prototype.normalize = function (form) {
    operations++
    return normalize.call(this, form)
  }
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    ticks++
  }, 0)
  const start = performance.now()
  try {
    await new V2Directories(fs, state, () => true, commit).scan()
  } finally {
    clearInterval(timer)
    String.prototype.normalize = normalize
  }
  longest = Math.max(longest, performance.now() - last)
  const elapsed = performance.now() - start
  console.info({ paths: files, folders: count, operations, ticks, longest, elapsed })
  expect(commit).not.toHaveBeenCalled()
  expect(operations).toBeLessThan(30 * (files + count))
  expect(ticks).toBeGreaterThan(0)
  // Overall work budget scales with inventory; heartbeat checks renderer latency.
  expect(elapsed).toBeLessThan((files + count) / 10)
  expect(longest).toBeLessThan(50)
})
