import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SqliteDatabase from 'better-sqlite3'
import type { Journal, StateEntry } from '@abele/sync-core'
import { SqliteStateStore } from '../../src/sqliteState.js'

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

async function collect(store: SqliteStateStore): Promise<StateEntry[]> {
  const found: StateEntry[] = []
  for await (const e of store.all()) found.push(e)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

let dir: string
let file: string
let store: SqliteStateStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-state-'))
  file = join(dir, 'nested', 'state.db')
  store = SqliteStateStore.open(file)
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

describe('SqliteStateStore', () => {
  it('pins a read-only snapshot across writer commits without taking a writer reservation', async () => {
    await store.put(entry())
    store.setMeta('status', 'before')
    const snapshot = SqliteStateStore.openReadOnlySnapshot(file)
    try {
      expect(await snapshot.transaction(async () => snapshot.getMeta('status'))).toBe('before')
      await store.transaction(async () => {
        await store.put(entry({ versionId: 'ver-2' }))
        store.setMeta('status', 'after')
      })
      expect(snapshot.getMeta('status')).toBe('before')
      expect(await snapshot.get('notes/a.md')).toMatchObject({ versionId: 'ver-1' })
      expect(() => snapshot.setMeta('status', 'must not write')).toThrow()
      await expect(snapshot.put(entry())).rejects.toMatchObject({ code: 'io' })
      expect(store.getMeta('status')).toBe('after')
      expect(await store.get('notes/a.md')).toMatchObject({ versionId: 'ver-2' })
    } finally {
      snapshot.close()
    }
  })

  it('never creates a missing ledger or its parent when opening a status snapshot', () => {
    const missing = join(dir, 'missing', 'ledger.db')
    expect(() => SqliteStateStore.openReadOnlySnapshot(missing)).toThrow()
    expect(existsSync(missing)).toBe(false)
    expect(existsSync(join(dir, 'missing'))).toBe(false)
  })

  it('creates the database file and its folder', () => {
    expect(existsSync(file)).toBe(true)
  })

  it("keeps the daemon's own meta apart from the cursor and the journal", async () => {
    expect(store.getMeta('selective')).toBeNull()
    store.setMeta('selective', 'abc')
    expect(store.getMeta('selective')).toBe('abc')
    // A daemon key spelled like an engine key reaches neither the cursor nor the journal.
    store.setMeta('cursor', '99')
    store.setMeta('journal', '{}')
    expect(await store.getCursor()).toBe(0)
    expect(await store.getJournal()).toBeNull()
    store.setMeta('selective', null)
    expect(store.getMeta('selective')).toBeNull()
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

  it('re-files a fileId under its new path and drops the row it left', async () => {
    await store.put(entry())
    const moved = entry({ path: 'notes/b.md', wirePath: 'notes/b.md', versionId: 'ver-2' })
    await store.put(moved)
    expect(await store.byFileId('file-1')).toEqual(moved)
    expect(await store.get('notes/a.md')).toBeNull()
    expect(await collect(store)).toEqual([moved])
  })

  it('keeps one row per wirePath, whatever fileId claims it', async () => {
    await store.put(entry({ path: 'Note.md', wirePath: 'Note.md' }))
    const other = entry({ path: 'nfd.md', wirePath: 'Note.md', fileId: 'file-2' })
    await store.put(other)
    expect(await collect(store)).toEqual([other])
    expect(await store.byFileId('file-1')).toBeNull()
  })

  it('clears the fileId index on delete, and deleting a missing path is not an error', async () => {
    await store.put(entry())
    await store.delete('notes/a.md')
    expect(await store.get('notes/a.md')).toBeNull()
    expect(await store.byFileId('file-1')).toBeNull()
    expect(await collect(store)).toEqual([])
    await expect(store.delete('notes/a.md')).resolves.toBeUndefined()
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

  it('keeps everything across a close and a reopen', async () => {
    await store.put(entry())
    await store.setCursor(7)
    await store.setJournal(journal())
    store.close()

    store = SqliteStateStore.open(file)
    expect(await collect(store)).toEqual([entry()])
    expect(await store.byFileId('file-1')).toEqual(entry())
    expect(await store.getCursor()).toBe(7)
    expect(await store.getJournal()).toEqual(journal())
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
        await store.put(entry({ path: 'notes/b.md', wirePath: 'notes/b.md', fileId: 'file-2' }))
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

  it('runs a nested transaction inside the outer one, committing once', async () => {
    await store.transaction(async () => {
      await store.put(entry())
      await store.transaction(async () => {
        await store.setCursor(5)
      })
    })
    expect(await store.get('notes/a.md')).toEqual(entry())
    expect(await store.getCursor()).toBe(5)
  })

  it('rolls the outer transaction back when a nested one throws through it', async () => {
    const boom = new Error('boom')
    await expect(
      store.transaction(async () => {
        await store.put(entry())
        await store.transaction(async () => {
          await store.setCursor(5)
          throw boom
        })
      })
    ).rejects.toBe(boom)
    expect(await collect(store)).toEqual([])
    expect(await store.getCursor()).toBe(0)
  })

  it('reports a closed database as an io error rather than a driver one', async () => {
    store.close()
    await expect(store.get('notes/a.md')).rejects.toMatchObject({ code: 'io' })
    await expect(store.put(entry())).rejects.toMatchObject({ code: 'io' })
    await expect(store.getCursor()).rejects.toMatchObject({ code: 'io' })
    await expect(store.transaction(async () => undefined)).rejects.toMatchObject({ code: 'io' })
    store = SqliteStateStore.open(file)
  })

  it('reports a database another writer holds as a conflict', async () => {
    const other = SqliteStateStore.open(file, { busyTimeoutMs: 0 })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    const outer = store.transaction(async () => {
      await store.put(entry())
      await held
    })
    try {
      await expect(
        other.transaction(async () => {
          await other.setCursor(1)
        })
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      release()
      await outer
      other.close()
    }
    expect(await store.get('notes/a.md')).toEqual(entry())
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

  it('copies the journal out, ops and all', async () => {
    await store.setJournal(journal())
    const fetched = await store.getJournal()
    fetched!.ops.push({ op: 'delete', file_id: 'file-2', base_version_id: 'ver-2' })
    fetched!.batchId = 'batch-2'
    expect(await store.getJournal()).toEqual(journal())
  })

  it('reports a journal that will not parse as an io failure rather than throwing raw', async () => {
    // Written straight into the engine's own row, past `setMeta`, which keeps clear of it.
    const raw = new SqliteDatabase(file)
    try {
      raw.prepare("insert into meta (key, value) values ('journal', '{not json')").run()
    } finally {
      raw.close()
    }
    await expect(store.getJournal()).rejects.toMatchObject({ code: 'io' })
  })
})
