import { expect, it } from 'vitest'
import { ExpectedWrites, sha256 } from '../../src/index.js'
import { PushDisk } from '../../src/pushDisk.js'
import { VerdictRecorder } from '../../src/pushRecord.js'
import type { PushReport } from '../../src/pusher.js'
import { SimScheduler } from './scheduler.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { DurableStateStore } from './durableState.js'

for (const mode of ['publication', 'move', 'remove'] as const) {
  for (const path of mode === 'publication' ? ['old.bin'] : ['old.bin', 'new.bin']) {
    it(`I2 D-058/D-059: ${mode} preserves ${path} saves at every settlement await`, async () => {
      async function run(inject?: string) {
        const scheduler = new SimScheduler(19),
          fs = new MemoryStreamingFS(scheduler),
          state = new DurableStateStore(scheduler)
        const original = new Uint8Array([1]),
          remote = new Uint8Array([2]),
          edit = new Uint8Array([3])
        const sha = await sha256(original),
          incoming = await sha256(remote)
        const base = {
          path: 'old.bin',
          wirePath: 'old.bin',
          fileId: 'file',
          versionId: 'a',
          sha,
          size: 1,
          mtime: 1,
        }
        await fs.writeAtomic('old.bin', original, 1)
        await state.put(base)
        if (mode === 'remove') await fs.writeAtomic('new.bin', remote, 1)
        const opts = { expected: new ExpectedWrites() }
        const disk = new PushDisk(fs, state, opts, sha256, new Map())
        const untouched = disk.untouched.bind(disk)
        disk.untouched = async (...args) => {
          await scheduler.point('settlement.untouched.before')
          const answer = await untouched(...args)
          await scheduler.point('settlement.untouched.after')
          return answer
        }
        const mark = scheduler.points.length
        let injected = false
        scheduler.hook = async (point) => {
          if (point === inject && !injected) {
            injected = true
            await fs.writeAtomic(path, edit, 1)
          }
        }
        if (mode === 'publication') {
          const report: PushReport = {
            committed: null,
            applied: 0,
            merged: 0,
            conflicts: 0,
            rejected: [],
            replayed: false,
            kept: [],
          }
          await new VerdictRecorder(fs, state, opts, report, sha256, new Map(), disk).take(
            { op: 'modify', file_id: 'file', base_version_id: 'a', sha, size: 1, mtime: 1 },
            {
              status: 'merged',
              file_id: 'file',
              version_id: 'b',
              path: 'old.bin',
              sha: incoming,
              size: 1,
              mtime: 2,
              seq: 2,
            },
            0,
            {
              stages: new Map(),
              fetched: new Map([[incoming, remote]]),
              runs: [[0]],
              wanted: new Set([incoming]),
              local: new Map(),
              stale: new Set(),
              bad: new Map(),
              writes: new Map([[0, incoming]]),
              aside: new Map(),
              staged: new Map(),
            }
          )
        } else await disk.place(base, 'new.bin')
        scheduler.hook = undefined
        if (inject) {
          expect(injected, inject).toBe(true)
          expect(fs.snapshot().get(path)?.[0], `${mode}/${inject}`).toBe(3)
        }
        return scheduler.points.slice(mark)
      }
      const points = await run()
      for (const point of points) await run(point)
      expect(points.length).toBeGreaterThan(0)
    }, 90_000)
  }
}
