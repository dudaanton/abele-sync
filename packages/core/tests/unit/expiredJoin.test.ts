import { expect, it, vi } from 'vitest'
import {
  ExpectedWrites,
  EngineError,
  MemoryFileSystem,
  MemoryStateStore,
  resumeJournal,
  sha256,
  type VaultClient,
} from '../../src/index.js'

it('keeps an expired prefer-mine journal for recovery instead of replaying it on an older server', async () => {
  const state = new MemoryStateStore()
  const journal = {
    batchId: 'b',
    idempotencyKey: 'k',
    startedAt: '2020-01-01T00:00:00Z',
    ops: [
      {
        op: 'create' as const,
        prefer: 'mine' as const,
        path: 'a.md',
        sha: 'a'.repeat(64),
        size: 1,
        mtime: 1,
      },
    ],
  }
  await state.setJournal(journal)
  const commitRaw = vi.fn()
  const client = { commitRaw } as unknown as VaultClient
  await expect(
    resumeJournal(client, new MemoryFileSystem(), state, { expected: new ExpectedWrites() })
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(commitRaw).not.toHaveBeenCalled()
  expect(await state.getJournal()).toEqual(journal)
})

it('does not refresh the first attempt time when an offline replay fails before receipt expiry', async () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    const bytes = new Uint8Array([97])
    const state = new MemoryStateStore()
    const fs = new MemoryFileSystem()
    await fs.writeAtomic('a.md', bytes, 1)
    const journal = {
      batchId: 'b',
      idempotencyKey: 'k',
      startedAt: '2026-01-01T01:00:00Z',
      ops: [
        {
          op: 'create' as const,
          prefer: 'mine' as const,
          path: 'a.md',
          sha: await sha256(bytes),
          size: 1,
          mtime: 1,
        },
      ],
    }
    await state.setJournal(journal)
    const putBlob = vi.fn().mockRejectedValue(new EngineError('offline', 'not sent'))
    const client = {
      hasBlob: async () => false,
      putBlob,
      commitRaw: vi.fn(),
    } as unknown as VaultClient
    const opts = { expected: new ExpectedWrites() }
    await expect(resumeJournal(client, fs, state, opts)).rejects.toThrow('not sent')
    expect(await state.getJournal()).toEqual(journal)
    vi.setSystemTime(new Date('2026-01-02T03:00:00Z'))
    await expect(resumeJournal(client, fs, state, opts)).rejects.toMatchObject({ code: 'conflict' })
    expect(putBlob).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
