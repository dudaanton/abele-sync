import { expect, it } from 'vitest'
import {
  ExpectedWrites,
  pull,
  push,
  resumeJournal,
  scan,
  sha256,
  type EngineClient,
} from '../../src/index.js'
import { DurableStateStore } from './durableState.js'
import { EpochError, SimScheduler } from './scheduler.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'

// Replay the public same-stat-save reproduction at every target read, and crash
// at every scheduled filesystem/state boundary in each resulting execution.
it.each([1, 2, 3, 4, 5, 6, 'source'] as const)(
  'adoption observation preserves local bytes across every crash (save=%s)',
  async (save) => {
    const bytes = ['sample A', 'sample B', 'sample C'].map((s) => new TextEncoder().encode(s))
    const hashes = await Promise.all(bytes.map(sha256))
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(177)
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      await fs.writeAtomic('old.md', bytes[0]!, 1000)
      await state.put({
        path: 'old.md',
        wirePath: 'old.md',
        fileId: 'sample',
        versionId: 'a',
        sha: hashes[0]!,
        size: 8,
        mtime: 1000,
      })
      await state.setCursor(1)
      await fs.move('old.md', 'Moved/new.md')
      let reads = 0,
        injected = false
      const instrument = () => {
        const read = fs.read.bind(fs),
          stat = fs.stat.bind(fs)
        fs.read = async (path) => {
          const data = await read(path)
          if (path === 'Moved/new.md' && ++reads === save && !injected) {
            await fs.writeAtomic(path, bytes[1]!, 1000)
            injected = true
          }
          return data
        }
        fs.stat = async (path) => {
          const data = await stat(path)
          if (save === 'source' && path === 'old.md' && data === null && !injected) {
            await fs.writeAtomic(path, bytes[1]!, 1000)
            injected = true
          }
          return data
        }
      }
      instrument()
      const head = save === 'source' ? 2 : 3
      const client = {
        changes: async (since: number) => {
          await scheduler.point('feed')
          const seq = since + 1
          return {
            items:
              since >= head
                ? []
                : [
                    {
                      seq,
                      file_id: 'sample',
                      version_id: seq === 2 ? 'b' : 'c',
                      path: 'Moved/new.md',
                      prev_path: seq === 2 ? 'old.md' : null,
                      op: seq === 2 ? 'move' : 'modify',
                      kind: 'note',
                      sha: hashes[save === 'source' ? 0 : seq - 1],
                      size: 8,
                      mtime: 1000,
                      at: '',
                      actor: { kind: 'system', id: 'sample', name: 'Sample' },
                    },
                  ],
            head_seq: head,
            next_since: Math.min(seq, head),
          }
        },
        getBlob: async (sha: string) => bytes[hashes.indexOf(sha)]!,
      } as unknown as EngineClient
      const run = () =>
        pull(client, fs, state, {
          dirty: new Set(),
          expected: new ExpectedWrites(),
          filter: { excluded: () => false },
        })
      const start = scheduler.points.length
      scheduler.cut = cut
      try {
        await run()
      } catch (error) {
        if (!(error instanceof EpochError) || cut === undefined) throw error
      }
      const points = scheduler.points.slice(start)
      if (cut) {
        expect(scheduler.epoch, cut).toBe(1)
        scheduler.cut = undefined
        fs = fs.reopen()
        state = state.reopen()
        instrument()
      }
      // A second pull must not turn the surviving save into a clean intermediate
      // version, including after replaying an interrupted metadata transaction.
      await run()
      if (injected) expect([...fs.snapshot().values()], cut).toContainEqual(bytes[1])
      if (save === 'source' && injected) {
        expect(fs.snapshot().get('Moved/new.md')).toEqual(bytes[0])
      }
      return points
    }
    const points = await execute()
    for (const cut of points) await execute(cut)
  },
  20000
)

it('classifies and uploads a recreated source under its own identity across every crash', async () => {
  const a = new TextEncoder().encode('sample A'),
    b = new TextEncoder().encode('sample B')
  const shaA = await sha256(a),
    shaB = await sha256(b)
  async function execute(cut?: string) {
    const scheduler = new SimScheduler(178)
    let fs = new MemoryStreamingFS(scheduler),
      state = new DurableStateStore(scheduler)
    await fs.writeAtomic('old.md', a, 1000)
    await fs.move('old.md', 'new.md')
    await state.put({
      path: 'old.md',
      wirePath: 'old.md',
      fileId: 'original',
      versionId: 'a',
      sha: shaA,
      size: 8,
      mtime: 1000,
    })
    await state.setCursor(1)
    const stat = fs.stat.bind(fs)
    let injected = false
    fs.stat = async (path) => {
      const have = await stat(path)
      if (path === 'old.md' && have === null && !injected) {
        await fs.writeAtomic(path, b, 1000)
        injected = true
      }
      return have
    }
    const receipts = new Map<string, Awaited<ReturnType<EngineClient['commitRaw']>>>()
    const client = {
      changes: async () => ({
        items: [
          {
            seq: 2,
            file_id: 'original',
            version_id: 'moved',
            op: 'move',
            path: 'new.md',
            prev_path: 'old.md',
            sha: shaA,
            size: 8,
            mtime: 1000,
            kind: 'note',
            at: '',
            actor: { kind: 'system', id: 'test', name: 'Test' },
          },
        ],
        head_seq: 2,
        next_since: 2,
      }),
      getBlob: async (sha: string) => (sha === shaA ? a : b),
      hasBlob: async () => false,
      putBlob: async (sha: string, bytes: Uint8Array) => {
        await scheduler.point('net.upload')
        expect(await sha256(bytes)).toBe(sha)
      },
      commitRaw: async (ops: Parameters<EngineClient['commitRaw']>[0], key: string) => {
        await scheduler.point('net.commit.before')
        let receipt = receipts.get(key)
        if (!receipt) {
          receipt = {
            replayed: false,
            body: {
              head_seq: 4,
              results: ops.map((op, i) => ({
                status: 'applied',
                file_id: op.op === 'move' ? 'original' : 'recreated',
                version_id: `accepted-${i}`,
                seq: i + 3,
                path: op.op === 'move' ? op.to_path : 'old.md',
                sha: op.op === 'move' ? shaA : shaB,
                size: 8,
                mtime: 1000,
              })),
            },
          }
          receipts.set(key, receipt)
        }
        await scheduler.point('net.commit.after')
        return receipt
      },
    } as unknown as EngineClient
    await pull(client, fs, state, {
      dirty: new Set(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    })
    expect(injected).toBe(true)
    const run = async () => {
      const options = { expected: new ExpectedWrites() }
      await resumeJournal(client, fs, state, options)
      const found = await scan(fs, state, { excluded: () => false })
      await push(client, fs, state, found, options)
    }
    const start = scheduler.points.length
    scheduler.cut = cut
    try {
      await run()
    } catch (error) {
      if (!(error instanceof EpochError) || !cut) throw error
    }
    const points = scheduler.points.slice(start)
    if (cut) {
      expect(scheduler.epoch, cut).toBe(1)
      scheduler.cut = undefined
      fs = fs.reopen()
      state = state.reopen()
      await run()
    }
    expect(fs.snapshot().get('old.md'), cut).toEqual(b)
    expect(fs.snapshot().get('new.md'), cut).toEqual(a)
    expect(await state.byFileId('original'), cut).toMatchObject({ path: 'new.md', sha: shaA })
    expect(await state.get('old.md'), cut).toMatchObject({ fileId: 'recreated', sha: shaB })
    expect(await state.getJournal()).toBeNull()
    expect(await state.getMeta('pull-source-recreated:original')).toBeNull()
    return points
  }
  const points = await execute()
  for (const cut of points) await execute(cut)
}, 20000)
