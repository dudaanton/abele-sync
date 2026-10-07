import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryStateStore, type Journal, type StateEntry } from '../../src/index.js'

const entry = (over: Partial<StateEntry> = {}): StateEntry => ({
  path: 'notes/a.md',
  wirePath: 'notes/a.md',
  fileId: 'file-1',
  versionId: 'ver-1',
  sha: 'a'.repeat(64),
  size: 5,
  mtime: 1000,
  ...over,
})

const journal = (over: Partial<Journal> = {}): Journal => ({
  batchId: 'batch-1',
  ops: [{ op: 'delete', file_id: 'file-1', base_version_id: 'ver-1' }],
  idempotencyKey: 'key-1',
  startedAt: '2026-09-05T00:00:00.000Z',
  ...over,
})

async function collect(store: MemoryStateStore): Promise<StateEntry[]> {
  const found: StateEntry[] = []
  for await (const e of store.all()) found.push(e)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

describe('MemoryStateStore', () => {
  let store: MemoryStateStore

  beforeEach(() => {
    store = new MemoryStateStore()
  })

  it('gets nothing before anything is put', async () => {
    expect(await store.get('notes/a.md')).toBeNull()
    expect(await store.byFileId('file-1')).toBeNull()
    expect(await collect(store)).toEqual([])
  })

  it('puts an entry and finds it by path and by fileId', async () => {
    const a = entry()
    await store.put(a)
    expect(await store.get('notes/a.md')).toEqual(a)
    expect(await store.byFileId('file-1')).toEqual(a)
    expect(await collect(store)).toEqual([a])
  })

  it('upserts by path rather than adding a second row', async () => {
    await store.put(entry())
    await store.put(entry({ versionId: 'ver-2', sha: 'b'.repeat(64), size: 9, mtime: 2000 }))
    expect(await collect(store)).toHaveLength(1)
    expect(await store.get('notes/a.md')).toMatchObject({ versionId: 'ver-2', size: 9 })
    expect(await store.byFileId('file-1')).toMatchObject({ versionId: 'ver-2' })
  })

  it('re-indexes fileId when the same file turns up under a new path', async () => {
    await store.put(entry())
    const moved = entry({ path: 'notes/b.md', wirePath: 'notes/b.md', versionId: 'ver-2' })
    await store.put(moved)
    expect(await store.byFileId('file-1')).toEqual(moved)
    // The old path's entry survives until the caller deletes it.
    expect(await store.get('notes/a.md')).toMatchObject({ path: 'notes/a.md' })
    await store.delete('notes/a.md')
    expect(await store.get('notes/a.md')).toBeNull()
    expect(await store.byFileId('file-1')).toEqual(moved)
  })

  it('clears the fileId index on delete, and deleting a missing path is not an error', async () => {
    await store.put(entry())
    await store.delete('notes/a.md')
    expect(await store.get('notes/a.md')).toBeNull()
    expect(await store.byFileId('file-1')).toBeNull()
    expect(await collect(store)).toEqual([])
    await expect(store.delete('notes/a.md')).resolves.toBeUndefined()
  })

  it('does not drop the index when a stale path is deleted after a move', async () => {
    await store.put(entry())
    const moved = entry({ path: 'notes/b.md', wirePath: 'notes/b.md' })
    await store.put(moved)
    await store.delete('notes/a.md')
    expect(await store.byFileId('file-1')).toEqual(moved)
  })

  it('round-trips the cursor, starting at zero', async () => {
    expect(await store.getCursor()).toBe(0)
    await store.setCursor(42)
    expect(await store.getCursor()).toBe(42)
  })

  it('round-trips the journal and clears it with null', async () => {
    expect(await store.getJournal()).toBeNull()
    const j = journal()
    await store.setJournal(j)
    expect(await store.getJournal()).toEqual(j)
    await store.setJournal(null)
    expect(await store.getJournal()).toBeNull()
  })

  it('runs the callback inside a transaction and returns its value', async () => {
    const result = await store.transaction(async () => {
      await store.put(entry())
      await store.setCursor(7)
      return 'done'
    })
    expect(result).toBe('done')
    expect(await store.get('notes/a.md')).toEqual(entry())
    expect(await store.getCursor()).toBe(7)
  })

  it('rolls every change back when the transaction throws', async () => {
    await store.put(entry())
    await store.setCursor(3)
    await store.setJournal(journal())

    const boom = new Error('boom')
    await expect(
      store.transaction(async () => {
        await store.put(entry({ path: 'notes/b.md', fileId: 'file-2' }))
        await store.delete('notes/a.md')
        await store.setCursor(99)
        await store.setJournal(null)
        throw boom
      })
    ).rejects.toBe(boom)

    expect(await collect(store)).toEqual([entry()])
    expect(await store.byFileId('file-1')).toEqual(entry())
    expect(await store.byFileId('file-2')).toBeNull()
    expect(await store.getCursor()).toBe(3)
    expect(await store.getJournal()).toEqual(journal())
  })

  it('keeps entries the caller mutates afterwards out of the store', async () => {
    const a = entry()
    await store.put(a)
    a.sha = 'c'.repeat(64)
    expect(await store.get('notes/a.md')).toMatchObject({ sha: 'a'.repeat(64) })
  })

  it('hands out copies of entries, so mutating a read does not reach the store', async () => {
    await store.put(entry())
    const byPath = await store.get('notes/a.md')
    byPath!.sha = 'c'.repeat(64)
    const byId = await store.byFileId('file-1')
    byId!.sha = 'd'.repeat(64)
    for await (const each of store.all()) each.sha = 'e'.repeat(64)
    expect(await store.get('notes/a.md')).toEqual(entry())
    expect(await store.byFileId('file-1')).toEqual(entry())
    expect(await collect(store)).toEqual([entry()])
  })

  it('copies the journal in, ops and all', async () => {
    const j = journal()
    await store.setJournal(j)
    j.ops.push({ op: 'delete', file_id: 'file-2', base_version_id: 'ver-2' })
    j.batchId = 'batch-2'
    expect(await store.getJournal()).toEqual(journal())
  })

  it('copies the journal out, ops and all', async () => {
    await store.setJournal(journal())
    const fetched = await store.getJournal()
    fetched!.ops.push({ op: 'delete', file_id: 'file-2', base_version_id: 'ver-2' })
    fetched!.batchId = 'batch-2'
    expect(await store.getJournal()).toEqual(journal())
  })

  it('rolls an in-place append to the journal ops back', async () => {
    await store.setJournal(journal())
    const boom = new Error('boom')
    await expect(
      store.transaction(async () => {
        const open = await store.getJournal()
        open!.ops.push({ op: 'delete', file_id: 'file-2', base_version_id: 'ver-2' })
        await store.setJournal(open)
        throw boom
      })
    ).rejects.toBe(boom)
    expect(await store.getJournal()).toEqual(journal())
  })
})
