import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites, sha256 } from '../../src/index.js'
import { pull, type PullOptions } from '../../src/puller.js'
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
  const run = (options: Partial<PullOptions> = {}) =>
    pull(client, fs, state, {
      dirty,
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
      ...options,
    })
  return { fs, state, add, run, dirty, bodies, hashes }
}

async function trackedFixture() {
  const f = await fixture()
  await f.state.put({
    path: 'file.bin',
    wirePath: 'file.bin',
    fileId: 'file',
    versionId: 'v0',
    sha: f.hashes[1]!,
    size: 1,
    mtime: 1,
  })
  return f
}

it('D-113 holds newer guarded-delete feed changes when resuming a completed manifest', async () => {
  const f = await trackedFixture()
  expect((await f.run()).held.map((change) => change.version_id)).toEqual(['v1'])
  await f.fs.remove('file.bin')
  f.add(2)
  const retry = await f.run({ noted: new Set(['file.bin']) })
  expect(retry.held.map((change) => change.version_id)).toEqual(['v2'])
  expect(retry.cursor).toBeLessThan(2)
  expect(retry.applied).toBe(0)
  expect((await f.state.get('file.bin'))?.versionId).toBe('v0')
})

it('I7: randomized protection combinations distinguish manifest notes from following holds', async () => {
  let random = 113
  const modes = ['walking', 'following', 'checkpoint'] as const
  // Enumerate every protection bit, randomizing occupants and combinations in each mode.
  for (const mode of modes)
    for (let mask = 0; mask < 512; mask++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0
      const f = await trackedFixture()
      if (mode === 'checkpoint') await f.run()
      if (mode === 'following') await f.state.setCursor(1)
      const missing = (random & 1) !== 0
      if (missing) await f.fs.remove('file.bin')
      else if ((random & 4) !== 0) await f.fs.writeAtomic('file.bin', new Uint8Array([9]), 1)
      const untracked = (mask & 64) !== 0
      if (untracked) await f.state.delete('file.bin')
      const dirty = (mask & 1) !== 0
      const held = (mask & 2) !== 0
      const guarded = (mask & 4) !== 0
      const noted = guarded || (mask & 128) !== 0 ? new Set(['file.bin']) : new Set<string>()
      f.dirty.clear()
      if (dirty || held || guarded) f.dirty.add('file.bin')
      const excluded = (mask & 32) !== 0
      const options: Partial<PullOptions> = {
        noted,
        protectMissing: (mask & 8) !== 0,
        preserveMissing: (mask & 16) !== 0 ? new Set(['file']) : new Set(),
        recheck: (mask & 256) !== 0 ? new Set(['file']) : new Set(),
        filter: { excluded: () => excluded },
      }
      f.add(2)
      const report = await f.run(options)
      const context = `${mode}, mask ${mask}, missing ${missing}, untracked ${untracked}`
      if (!excluded && f.dirty.size > 0) {
        // Only manifest inventory may note a guarded delete. Its newer feed version must hold.
        expect(
          report.held.some((change) => change.version_id === 'v2'),
          context
        ).toBe(true)
        expect(report.cursor, context).toBeLessThan(2)
      }
      for (const change of report.held) {
        const retry = await f.run(options)
        expect(
          retry.held.some((item) => item.version_id === change.version_id),
          context
        ).toBe(true)
        expect(retry.cursor, context).toBeLessThan(change.seq)
      }
    }
})

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
      } else {
        if (random % 7 === 0) f.dirty.clear()
        else f.dirty.add('file.bin')
        if (random % 3 !== 0) f.add((random >>> 8) % 3)
      }
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
