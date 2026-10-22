import { expect, it } from 'vitest'
import type { CommitOp } from '@abele/sync-protocol'
import { batches } from '../../src/pushBatches.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { scan } from '../../src/scanner.js'
import { push, resumeJournal } from '../../src/pusher.js'
import { ExpectedWrites } from '../../src/echo.js'
import type { EngineClient } from '../../src/engineClient.js'

const create = (n: number, size = 1): CommitOp => ({
  op: 'create',
  path: `${n}.bin`,
  sha: 'a'.repeat(64),
  size,
  mtime: 1,
})

it('bounds each first-upload commit to 100 operations', () => {
  const ops = Array.from({ length: 250 }, (_, n) => create(n))
  expect(batches(ops).map((batch) => batch.length)).toEqual([100, 100, 50])
  expect(batches(ops).flat()).toEqual(ops)
})

it('bounds content per commit to 8 MiB without separating a move and modify', () => {
  const ops: CommitOp[] = [
    create(0, 5 * 1024 * 1024),
    { op: 'move', file_id: 'f', base_version_id: 'v', to_path: 'moved.bin' },
    create(1),
    {
      op: 'modify',
      file_id: 'f',
      base_version_id: 'v',
      sha: 'b'.repeat(64),
      size: 4 * 1024 * 1024,
      mtime: 1,
    },
  ]
  expect(batches(ops).map((batch) => batch.map((op) => op.op))).toEqual([
    ['create'],
    ['move', 'modify', 'create'],
  ])
})

it('sends an indivisible large file alone and preserves the operation boundary for a pair', () => {
  const ops: CommitOp[] = [
    ...Array.from({ length: 99 }, (_, n) => create(n)),
    { op: 'move', file_id: 'f', base_version_id: 'v', to_path: 'moved.bin' },
    {
      op: 'modify',
      file_id: 'f',
      base_version_id: 'v',
      sha: 'b'.repeat(64),
      size: 9 * 1024 * 1024,
      mtime: 1,
    },
    create(100),
  ]
  expect(batches(ops).map((batch) => batch.length)).toEqual([99, 2, 1])
})

it('durably records each small batch before sending the next and replays only the interrupted batch', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  for (let n = 0; n < 250; n++) await fs.writeAtomic(`${n}.bin`, new Uint8Array([1]), 1)
  const counts: number[] = [],
    keys: string[] = []
  let fail = true
  const client = {
    hasBlob: async () => true,
    commitRaw: async (ops: CommitOp[], key: string) => {
      let recorded = 0
      for await (const _entry of state.all()) recorded++
      counts.push(recorded)
      keys.push(key)
      if (counts.length === 2 && fail) throw new Error('interrupted second batch')
      return {
        replayed: counts.length === 3,
        body: {
          head_seq: 250,
          results: ops.map((op) => {
            if (op.op !== 'create') throw new Error('unexpected operation')
            return { ...op, status: 'applied', file_id: op.path, version_id: 'v1', seq: 1 }
          }),
        },
      }
    },
  } as unknown as EngineClient
  const options = { expected: new ExpectedWrites() },
    filter = { excluded: () => false }
  await expect(push(client, fs, state, await scan(fs, state, filter), options)).rejects.toThrow(
    'interrupted second batch'
  )
  expect(counts).toEqual([0, 100])
  expect((await state.getJournal())?.ops).toHaveLength(100)
  fail = false
  await resumeJournal(client, fs, state, options)
  await push(client, fs, state, await scan(fs, state, filter), options)
  expect(counts).toEqual([0, 100, 100, 200])
  expect(keys[2]).toBe(keys[1])
  expect(await state.getJournal()).toBeNull()
})
