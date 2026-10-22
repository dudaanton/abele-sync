import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites, sha256 } from '../../src/index.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bodies = [1, 2, 3].map((n) => new Uint8Array([n]))
  const hashes = await Promise.all(bodies.map(sha256))
  await fs.writeAtomic('file.bin', bodies[1]!, 1)
  const feed: ChangeItem[] = []
  const add = (value: number) => {
    const seq = feed.length + 1
    feed.push({
      seq,
      file_id: 'file',
      version_id: `v${seq}`,
      op: 'modify',
      path: 'file.bin',
      prev_path: null,
      sha: hashes[value]!,
      size: 1,
      mtime: 1,
      kind: 'attachment',
      actor: { kind: 'system', id: 'server', name: 'server' },
      at: '',
    })
  }
  add(0)
  const client = {
    manifest: async () => ({ items: [feed[0]!], head_seq: 1, next: null }),
    changes: async (since: number) => {
      const next = feed.find((change) => change.seq > since)
      return {
        items: next ? [next] : [],
        head_seq: feed.length,
        next_since: next?.seq ?? feed.length,
      }
    },
    getBlob: async (sha: string) => bodies[hashes.indexOf(sha)]!,
  } as unknown as EngineClient
  const dirty = new Set(['file.bin'])
  const run = () =>
    pull(client, fs, state, {
      dirty,
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
  return { fs, state, add, run, dirty, bodies }
}

it('D-110 retries v3 held after a later page adopts v2 instead of trusting the original null base', async () => {
  const f = await fixture()
  f.add(1)
  f.add(2)
  const first = await f.run()
  expect(first.held.map((change) => change.version_id)).toEqual(['v3'])
  expect((await f.state.get('file.bin'))?.versionId).toBe('v2')
  const retry = await f.run()
  expect(retry.held.map((change) => change.version_id)).toEqual(['v3'])
  expect(retry.cursor).toBeLessThan(3)
  expect(await f.fs.read('file.bin')).toEqual(f.bodies[1])
  f.dirty.clear()
  const resumed = await f.run()
  expect(resumed.held).toEqual([])
  expect(resumed.cursor).toBe(3)
  expect((await f.state.get('file.bin'))?.versionId).toBe('v3')
})

it('I7: seeded random hold/adopt/retry orders never drop an unresolved held version', async () => {
  for (let seed = 1; seed <= 32; seed++) {
    const f = await fixture()
    let random = seed
    for (let step = 0; step < 16; step++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      if (step === 0) {
        f.add(1)
        f.add(2)
      } else if (random % 3 !== 0) f.add((random >>> 8) % 3)
      const report = await f.run()
      for (const held of report.held) {
        const retry = await f.run()
        const adopted = (await f.state.byFileId(held.file_id))?.versionId === held.version_id
        expect(
          adopted || retry.held.some((change) => change.version_id === held.version_id),
          `seed ${seed}, step ${step}`
        ).toBe(true)
        if (!adopted) expect(retry.cursor).toBeLessThan(held.seq)
      }
    }
  }
})
