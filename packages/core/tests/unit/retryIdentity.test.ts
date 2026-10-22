import { afterEach, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { pull, applyStaged } from '../../src/puller.js'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { StateTransaction } from '../../src/stateTransaction.js'
import { FileRetries } from '../../src/fileRetry.js'
import { resumeReceipts, resumeJournal } from '../../src/pusher.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { stoppableFileEffects } from '../../src/guard.js'
import { SyncCancelled } from '../../src/cancellation.js'
import type { EngineClient } from '../../src/engineClient.js'

afterEach(() => vi.restoreAllMocks())

it('D-149 a staged move stays held when a different identity owns its destination', async () => {
  const f = await fixture()
  const source = {
    path: 'old.bin',
    wirePath: 'old.bin',
    fileId: 'A',
    versionId: 'v0',
    sha: f.sha,
    size: 1,
    mtime: 1,
  }
  const occupant = { ...source, path: 'new.bin', wirePath: 'new.bin', fileId: 'B', versionId: 'v3' }
  await f.state.put(source)
  await f.state.put(occupant)
  await f.fs.writeAtomic('new.bin', f.bytes, 1)
  const change: ChangeItem = {
    file_id: 'A',
    version_id: 'v1',
    path: 'new.bin',
    prev_path: 'old.bin',
    op: 'move',
    seq: 1,
    sha: f.sha,
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'test', name: 'test' },
    at: '',
  }
  const report = await applyStaged(f.client, f.fs, f.state, [change], {
    expected: new ExpectedWrites(),
    dirty: new Set(),
    filter: { excluded: () => false },
  })
  expect(report.held).toEqual([change])
  expect(await f.state.get('new.bin')).toEqual(occupant)
  expect(await f.fs.read('old.bin')).toEqual(f.bytes)
})

it('receipt and journal retries cannot steal paths from identities installed by newer feed pages', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          id: fc.constantFrom('A', 'B', 'C'),
          journal: fc.boolean(),
          duplicate: fc.boolean(),
          acknowledged: fc.boolean(),
        }),
        { minLength: 2, maxLength: 12 }
      ),
      async (actions) => {
        const f = await fixture()
        const source = {
          path: 'old.bin',
          wirePath: 'old.bin',
          fileId: 'A',
          versionId: 'v0',
          sha: f.sha,
          size: 1,
          mtime: 1,
        }
        await f.state.put(source)
        await f.state.setCursor(1)
        const op = { op: 'move' as const, file_id: 'A', base_version_id: 'v0', to_path: 'new.bin' }
        const result = {
          status: 'applied' as const,
          file_id: 'A',
          version_id: 'v1',
          path: 'new.bin',
          sha: f.sha,
          size: 1,
          mtime: 1,
          seq: 1,
        }
        let seq = 1
        for (const action of actions) {
          seq++
          const change: ChangeItem = {
            file_id: action.id,
            version_id: `feed-${seq}`,
            path: 'new.bin',
            seq,
            sha: f.sha,
            size: 1,
            mtime: 1,
            kind: 'attachment',
            op: 'create',
            prev_path: null,
            actor: { kind: 'system', id: 'test', name: 'test' },
            at: '',
          }
          f.client.changes = async () => ({ items: [change], head_seq: seq, next_since: seq })
          await pull(f.client, f.fs, f.state, {
            expected: new ExpectedWrites(),
            dirty: new Set(),
            filter: { excluded: () => false },
          })
          expect((await f.state.get('new.bin'))?.fileId).toBe(action.id)
          const before = []
          for await (const entry of f.state.all()) before.push(entry)
          const old = await f.fs.stat('old.bin')
          for (let i = 0; i < (action.duplicate ? 2 : 1); i++) {
            if (action.journal) {
              await f.state.setJournal({
                ops: [op],
                idempotencyKey: 'move',
                batchId: 'move',
                startedAt: new Date().toISOString(),
              })
              f.client.commitRaw = async () => ({
                replayed: action.acknowledged,
                body: { head_seq: seq, results: [result] },
              })
              await resumeJournal(f.client, f.fs, f.state, {
                expected: new ExpectedWrites(),
                retries: f.retries,
              })
            } else {
              await f.state.setMeta(
                f.key,
                JSON.stringify({ path: 'new.bin', op, result, base: source })
              )
              await f.retries.retryNow()
              await f.run()
            }
            const after = []
            for await (const entry of f.state.all()) after.push(entry)
            expect(after).toEqual(before)
            expect(await f.fs.stat('old.bin')).toEqual(old)
            expect(await f.fs.read('new.bin')).toEqual(f.bytes)
            expect(await f.state.getCursor()).toBe(seq)
          }
        }
      }
    ),
    { seed: 149, numRuns: 40 }
  )
})

it.each([
  ['receipt', 'new.bin', 'new.bin'],
  ['journal', 'new.bin', 'new.bin'],
  ['receipt', 'Café.bin', 'Cafe\u0301.bin'],
  ['journal', 'Café.bin', 'Cafe\u0301.bin'],
] as const)(
  'D-149 %s replay preserves a replacement destination at %s (%s) even with equal bytes',
  async (kind, wire, path) => {
    const f = await fixture()
    const source = {
      path: 'old.bin',
      wirePath: 'old.bin',
      fileId: 'A',
      versionId: 'v0',
      sha: f.sha,
      size: 1,
      mtime: 1,
    }
    const occupant = {
      ...source,
      path,
      wirePath: wire,
      fileId: 'B',
      versionId: 'v3',
    }
    await f.state.put(source)
    await f.state.put(occupant)
    await f.fs.writeAtomic(path, f.bytes, 1)
    await f.state.setCursor(100)
    const op = { op: 'move' as const, file_id: 'A', base_version_id: 'v0', to_path: wire }
    const result = {
      status: 'applied' as const,
      file_id: 'A',
      version_id: 'v1',
      path: wire,
      sha: f.sha,
      size: 1,
      mtime: 1,
      seq: 1,
    }
    if (kind === 'receipt') {
      await f.state.setMeta(f.key, JSON.stringify({ path: wire, op, result, base: source }))
      await f.run()
    } else {
      await f.state.setMeta(f.key, null)
      await f.state.setJournal({
        ops: [op],
        idempotencyKey: 'move',
        batchId: 'move',
        startedAt: new Date().toISOString(),
      })
      f.client.commitRaw = async () => ({
        replayed: true,
        body: { head_seq: 100, results: [result] },
      })
      await resumeJournal(f.client, f.fs, f.state, {
        expected: new ExpectedWrites(),
        retries: f.retries,
      })
    }
    expect(await f.fs.read('old.bin')).toEqual(f.bytes)
    expect(await f.fs.read(path)).toEqual(f.bytes)
    expect(await f.state.byFileId('A')).toEqual(source)
    expect(await f.state.byFileId('B')).toEqual(occupant)
    expect(await f.state.get(path)).toEqual(occupant)
    expect(await f.state.getCursor()).toBe(100)
  }
)

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  const op = { op: 'create' as const, path: 'old.bin', sha, size: 1, mtime: 1 }
  const result = { ...op, status: 'applied' as const, file_id: 'file', version_id: 'v1', seq: 1 }
  const key = 'push-receipt:file'
  await fs.writeAtomic('old.bin', bytes, 1)
  await state.setMeta(key, JSON.stringify({ path: op.path, op, result }))
  const retries = new FileRetries(
    state,
    () => 10000,
    () => {}
  )
  await retries.failed(op.path, 'recovery', new Error('retry receipt'))
  await retries.retryNow()
  const client = { getBlob: vi.fn(async () => bytes) } as unknown as EngineClient
  const run = () => resumeReceipts(client, fs, state, { expected: new ExpectedWrites(), retries })
  return { fs, state, bytes, sha, op, result, key, retries, client, run }
}

it.each(['legacy', 'bound'] as const)(
  'D-146 does not replay a %s receipt over a later rename',
  async (format) => {
    const f = await fixture()
    if (format === 'bound')
      await f.state.setMeta(
        f.key,
        JSON.stringify({ path: 'old.bin', op: f.op, result: f.result, base: null })
      )
    await f.fs.move('old.bin', 'new.bin')
    const advanced = {
      path: 'new.bin',
      wirePath: 'new.bin',
      fileId: 'file',
      versionId: 'v2',
      sha: f.sha,
      size: 1,
      mtime: 1,
    }
    await f.state.put(advanced)
    await f.state.setCursor(2)
    await f.run()
    expect(await f.fs.stat('old.bin')).toBeNull()
    expect(await f.fs.read('new.bin')).toEqual(f.bytes)
    expect(await f.state.byFileId('file')).toEqual(advanced)
    expect(await f.state.getCursor()).toBe(2)
    expect(await f.state.getMeta(f.key)).toBeNull()
    expect(f.client.getBlob).not.toHaveBeenCalled()
  }
)

it('D-146 does not resurrect a create receipt after a later deletion', async () => {
  const f = await fixture()
  await f.fs.remove('old.bin')
  await f.state.setCursor(2)
  await f.run()
  expect(await f.fs.stat('old.bin')).toBeNull()
  expect(await f.state.byFileId('file')).toBeNull()
  expect(await f.state.getMeta(f.key)).toBeNull()
})

it('D-146 journal answer replay also preserves an identity advanced by a later rename', async () => {
  const f = await fixture()
  await f.state.setMeta(f.key, null)
  await f.fs.move('old.bin', 'new.bin')
  const advanced = {
    path: 'new.bin',
    wirePath: 'new.bin',
    fileId: 'file',
    versionId: 'v2',
    sha: f.sha,
    size: 1,
    mtime: 1,
  }
  await f.state.put(advanced)
  await f.state.setCursor(2)
  await f.state.setJournal({
    ops: [f.op],
    idempotencyKey: 'original',
    batchId: 'batch',
    startedAt: new Date().toISOString(),
  })
  f.client.hasBlob = async () => true
  f.client.commitRaw = vi.fn(async () => ({
    replayed: true,
    body: { head_seq: 2, results: [f.result] },
  }))
  await resumeJournal(f.client, f.fs, f.state, {
    expected: new ExpectedWrites(),
    retries: f.retries,
  })
  expect(await f.fs.stat('old.bin')).toBeNull()
  expect(await f.state.byFileId('file')).toEqual(advanced)
  expect(await f.state.getJournal()).toBeNull()
  expect(f.client.commitRaw).toHaveBeenCalledWith([f.op], 'original')
})
