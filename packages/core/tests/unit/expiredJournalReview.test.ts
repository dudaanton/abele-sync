import { expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { resumeJournal } from '../../src/pusher.js'
import { readReconciliation } from '../../src/reconciliation.js'
import type { EngineClient } from '../../src/engineClient.js'
import { SyncEngine } from '../../src/engine.js'
import { selectiveDefaults } from '../../src/selective.js'
import { sha256 } from '../../src/hash.js'

it('D-018 engine restarts reconciliation without reusing the expired prefer-mine choice', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  await fs.writeAtomic('note.md', bytes, 1)
  await state.setJournal({
    batchId: 'batch',
    idempotencyKey: 'old-request',
    startedAt: '2020-01-01T00:00:00Z',
    ops: [{ op: 'create', prefer: 'mine', path: 'note.md', sha, size: 1, mtime: 1 }],
  })
  const commitRaw = vi.fn(async (ops: Parameters<EngineClient['commitRaw']>[0]) => ({
    replayed: false,
    body: {
      head_seq: 2,
      results: ops.map((op) => {
        expect(op.op).toBe('create')
        if (op.op !== 'create') throw new Error('unexpected operation')
        expect(op.prefer).toBeUndefined()
        return { ...op, status: 'applied' as const, file_id: 'file', version_id: 'version', seq: 2 }
      }),
    },
  }))
  const client = {
    state: async () => ({ head_seq: 1, settings: { max_file_bytes: 10000, quota_bytes: null } }),
    manifest: async () => ({ items: [], next: null, head_seq: 1 }),
    changes: async () => ({ items: [], next_since: 2, head_seq: 2 }),
    hasBlob: async () => true,
    commitRaw,
  } as unknown as EngineClient
  const engine = new SyncEngine({
    fs,
    state,
    client,
    selective: selectiveDefaults(),
    joinPrefer: 'mine',
  })
  expect((await engine.sync()).push.applied).toBe(1)
  expect(commitRaw).toHaveBeenCalledTimes(1)
  expect(await state.getJournal()).toBeNull()
  expect(await state.getMeta('expired-journal:old-request')).not.toBeNull()
  await engine.stop()
})

it('D-018 archives an expired destructive join once and lets later sync reconcile safely', async () => {
  const state = new MemoryStateStore(),
    fs = new MemoryFileSystem()
  const journal = {
    batchId: 'batch',
    idempotencyKey: 'request',
    startedAt: '2020-01-01T00:00:00Z',
    ops: [
      {
        op: 'create' as const,
        path: 'note.md',
        prefer: 'mine' as const,
        sha: 'a'.repeat(64),
        size: 1,
        mtime: 1,
      },
    ],
  }
  await state.setJournal(journal)
  const commitRaw = vi.fn()
  const client = { commitRaw } as unknown as EngineClient
  await expect(
    resumeJournal(client, fs, state, { expected: new ExpectedWrites() })
  ).resolves.toMatchObject({ reconciliationRequired: true })
  expect(await state.getJournal()).toBeNull()
  expect(JSON.parse((await state.getMeta('expired-journal:request'))!)).toEqual(journal)
  expect((await readReconciliation(state))?.phase).toBe('requested')
  await expect(
    resumeJournal(client, fs, state, { expected: new ExpectedWrites() })
  ).resolves.toBeNull()
  expect(commitRaw).not.toHaveBeenCalled()
})
