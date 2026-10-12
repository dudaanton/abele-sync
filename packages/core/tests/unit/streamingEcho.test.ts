import { expect, it } from 'vitest'
import { MemoryFileSystem, ExpectedWrites, sha256 } from '../../src/index.js'
import { WatchReports } from '../../src/watchReports.js'

it('verifies watcher echoes incrementally instead of reporting an engine write as a user edit', async () => {
  const fs = new MemoryFileSystem()
  const bytes = new Uint8Array(1024 * 1024 + 7)
  await fs.writeAtomic('file.bin', bytes, 1000)
  const expected = new ExpectedWrites()
  expected.expect('file.bin', await sha256(bytes))
  let closed = false
  Object.assign(fs, {
    read: async () => {
      throw new Error('whole read forbidden')
    },
    openRead: async () => ({
      size: bytes.length,
      async read(at: number, length: number) {
        expect(length).toBeLessThanOrEqual(1024 * 1024)
        return bytes.slice(at, at + length)
      },
      async assertUnchanged() {},
      async close() {
        closed = true
      },
    }),
  })
  const reports = new WatchReports({ fs, expected, debounceMs: 1000, onChange() {} })
  reports.notice(['file.bin'])
  expect(await reports.examine()).toBe(false)
  expect(reports.reported.size).toBe(0)
  expect(closed).toBe(true)
})
