import { expect, it, vi } from 'vitest'
import { AbeleError } from '@abele/sync-protocol'
import { MemoryFileSystem, MemoryStateStore, ExpectedWrites, scan, push } from '../../src/index.js'
import type { EngineClient } from '../../src/engineClient.js'

it('reports size refusals by logical path with size and limit, including shared content and cached renames', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new TextEncoder().encode('abcdef')
  for (const path of ['first.bin', 'second.bin']) await fs.writeAtomic(path, bytes, 1)
  const putBlob = vi.fn(async () => {
    throw new AbeleError('too_large', 'file exceeds limit', { size: 6, max_bytes: 3 })
  })
  const client = {
    hasBlob: async () => false,
    putBlob,
    commitRaw: async () => {
      throw new Error('unexpected commit')
    },
  } as unknown as EngineClient
  const refused = new Map(),
    logs: string[] = []
  const run = async () =>
    push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
      expected: new ExpectedWrites(),
      refused,
      log: (message) => logs.push(message),
    })
  const first = await run()
  for (const path of ['first.bin', 'second.bin']) {
    const reason = first.rejected.find((item) => 'path' in item.op && item.op.path === path)!
    expect(reason).toMatchObject({ path, size: 6, limit: 3, code: 'too_large' })
    expect(reason.message).toContain(path)
  }
  const sha = (await scan(fs, state, { excluded: () => false })).hashes.get('first.bin')!
  expect(logs.join('\n')).not.toContain(sha)
  await fs.move('first.bin', 'renamed.bin')
  const cached = await run()
  expect(
    cached.rejected.find((item) => 'path' in item.op && item.op.path === 'renamed.bin')
  ).toMatchObject({
    path: 'renamed.bin',
    size: 6,
    limit: 3,
    message: expect.stringContaining('renamed.bin'),
  })
  expect(putBlob).toHaveBeenCalledTimes(1)
})

it.each(['quota_exceeded', 'quota_waiting', 'scripts_forbidden'] as const)(
  'reports %s against the current logical path',
  async (code) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    await fs.writeAtomic('note.md', new Uint8Array([1]), 1)
    const upload = code !== 'scripts_forbidden'
    const client = {
      hasBlob: async () => !upload,
      putBlob: async () => {
        throw new AbeleError(code, 'server refusal')
      },
      commitRaw: async () => ({
        replayed: false,
        body: { head_seq: 0, results: [{ status: 'rejected', code, message: 'server refusal' }] },
      }),
    } as unknown as EngineClient
    const report = await push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
      expected: new ExpectedWrites(),
    })
    expect(report.rejected[0]).toMatchObject({
      path: 'note.md',
      size: 1,
      code,
      message: expect.stringContaining('note.md'),
    })
  }
)

it.each(['commit', 'batch', 'path'] as const)(
  'keeps logical paths and known limits on %s refusals for tracked files',
  async (lane) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const original = new Uint8Array([1])
    const { sha256 } = await import('../../src/index.js')
    await fs.writeAtomic('Cafe\u0301.md', original, 1)
    await state.put({
      path: 'Cafe\u0301.md',
      wirePath: 'Café.md',
      fileId: 'file',
      versionId: 'base',
      sha: await sha256(original),
      size: 1,
      mtime: 1,
    })
    await fs.writeAtomic('Cafe\u0301.md', new Uint8Array([2, 3, 4, 5]), 2)
    const client = {
      hasBlob: async () => true,
      ...(lane === 'path'
        ? { pathRefusal: () => ({ code: 'too_large', message: 'path refused' }) }
        : {}),
      commitRaw: async () => {
        if (lane === 'batch') throw new AbeleError('too_large', 'batch refused')
        return {
          replayed: false,
          body: {
            head_seq: 0,
            results: [{ status: 'rejected', code: 'too_large', message: 'file refused' }],
          },
        }
      },
    } as unknown as EngineClient
    const report = await push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
      expected: new ExpectedWrites(),
      maxFileBytes: 3,
    })
    expect(report.rejected[0]).toMatchObject({
      path: 'Café.md',
      size: 4,
      limit: 3,
      message: expect.stringContaining('Café.md'),
    })
    expect(await fs.read('Cafe\u0301.md')).toEqual(new Uint8Array([2, 3, 4, 5]))
  }
)

it('does not mislabel a request-body refusal with an unrelated larger file ceiling', async () => {
  const { rejectedOp } = await import('../../src/pushRefusal.js')
  const reason = await rejectedOp(
    new MemoryStateStore(),
    {
      op: 'create',
      path: 'small.bin',
      sha: 'a'.repeat(64),
      size: 6,
      mtime: 1,
    },
    { code: 'too_large', message: 'request body too large' },
    100
  )
  expect(reason).toMatchObject({ path: 'small.bin', size: 6, limit: null })
  expect(reason.message).toContain('limit unknown')
})
