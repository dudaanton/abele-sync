import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SqliteDatabase from 'better-sqlite3'
import { concurrentPlacement } from '../../../core/tests/helpers/concurrentPlacement.js'
import type { Journal, StateEntry } from '@abele/sync-core'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { MemoryFileSystem, refreshLocalPaths, reconcileGeneration } from '@abele/sync-core'
import { afterStateCommit, transact } from '@abele/sync-core'
import {
  identityReplacement,
  rollbackIsolation,
} from '../../../core/tests/helpers/stateTransactionContract.js'

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

it('D-214 acknowledges nested work only after the raw SQLite owner commits', async () => {
  let acknowledged = 0
  const work = () =>
    store.transaction(async (outer) => {
      await transact(outer, async (tx) => {
        await tx.setMeta!('owned', 'value')
        afterStateCommit(tx, () => {
          acknowledged++
        })
      })
      expect(acknowledged).toBe(0)
    })
  await expect(
    store.transaction(async (outer) => {
      await transact(outer, async (tx) => {
        await tx.setMeta!('owned', 'rolled back')
        afterStateCommit(tx, () => {
          acknowledged++
        })
      })
      expect(acknowledged).toBe(0)
      throw new Error('outer rollback')
    })
  ).rejects.toThrow('outer rollback')
  expect(acknowledged).toBe(0)
  expect(await store.getMeta('owned')).toBeNull()
  await work()
  expect(acknowledged).toBe(1)
  expect(await store.getMeta('owned')).toBe('value')
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
  it('settles concurrent placements through its native scoped transactions', async () => {
    await concurrentPlacement(store)
  })
  it('keeps identity indexes consistent through path replacement and nested publication', async () => {
    await identityReplacement(store)
  })
  it.each(['cursor', 'daemon:server-restore-generation'])(
    'rolls back generation retirement when durable publication of %s fails',
    async (key) => {
      await reconcileGeneration(store, 'before')
      await store.put(entry())
      await store.setCursor(42)
      await store.setJournal(journal())
      await store.setMeta('pull-write:file-1', 'retained intent')
      const raw = new SqliteDatabase(file)
      try {
        raw.exec(`CREATE TRIGGER fail_generation BEFORE INSERT ON meta
          WHEN NEW.key = '${key}' BEGIN SELECT RAISE(ABORT, 'injected durable write failure'); END`)
        await expect(reconcileGeneration(store, 'after')).rejects.toMatchObject({ code: 'io' })
        expect(await store.get('notes/a.md')).toEqual(entry())
        expect(await store.getCursor()).toBe(42)
        expect(await store.getJournal()).toEqual(journal())
        expect(await store.getMeta('pull-write:file-1')).toBe('retained intent')
        expect(await store.getMeta('server-restore-generation')).toBe('before')
        expect(await store.getMeta('retired-generation:before')).toBeNull()
        raw.exec('DROP TRIGGER fail_generation')
        expect(await reconcileGeneration(store, 'after')).toBe(true)
        expect(await store.getCursor()).toBe(0)
        expect(await store.get('notes/a.md')).toBeNull()
        expect(await store.getMeta('server-restore-generation')).toBe('after')
      } finally {
        raw.close()
      }
    }
  )
  it('isolates unrelated writes from a suspended SQLite transaction rollback', async () => {
    await rollbackIsolation(store)
  })
  it('preserves SQLite uniqueness in scoped reads, including nested transactions', async () => {
    await store.put(entry())
    await store.transaction(async (tx) => {
      await tx.put(entry({ path: 'notes/b.md', wirePath: 'notes/b.md' }))
      expect(await tx.get('notes/a.md')).toBeNull()
      await tx.transaction(async (nested) => {
        await nested.put(entry({ path: 'notes/c.md', wirePath: 'notes/b.md', fileId: 'other' }))
        expect(await nested.get('notes/b.md')).toBeNull()
      })
      expect(await tx.byFileId('file-1')).toBeNull()
    })
    expect(await store.get('notes/c.md')).toMatchObject({ fileId: 'other' })
  })
  it('rejects a stale patch after an independent connection commits', async () => {
    const other = SqliteStateStore.open(file)
    try {
      await expect(
        store.transaction(async (tx) => {
          await tx.setCursor(20)
          other.setMeta('outside', 'survives')
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await store.getCursor()).toBe(0)
      expect(store.getMeta('outside')).toBe('survives')
    } finally {
      other.close()
    }
  })
  it('rolls back the whole published patch when ownership is lost before SQL commit', async () => {
    store.close()
    let armed = false
    store = SqliteStateStore.open(file, {
      effectGuard: () => {
        if (armed && store.getMeta('atomic') === 'written') throw new Error('lost before commit')
      },
    })
    await expect(
      store.transaction(async (tx) => {
        await tx.put(entry())
        await tx.setCursor(20)
        await tx.setMeta!('atomic', 'written')
        armed = true
      })
    ).rejects.toThrow('lost before commit')
    armed = false
    expect(store.getMeta('atomic')).toBeNull()
    expect(await store.getCursor()).toBe(0)
    expect(await collect(store)).toEqual([])
  })
  it('rekeys a normalization-only local rename with exactly one SQLite file identity', async () => {
    const fs = new MemoryFileSystem()
    const original = entry({ path: 'й/ё.md', wirePath: 'й/ё.md' })
    await store.put(original)
    await fs.writeAtomic(original.path.normalize('NFD'), new Uint8Array(5), original.mtime)
    await refreshLocalPaths(fs, store)
    expect(await store.get(original.path)).toBeNull()
    expect(await store.byFileId(original.fileId)).toEqual({
      ...original,
      path: original.path.normalize('NFD'),
    })
    expect(await collect(store)).toHaveLength(1)
  })
  it('pins a read-only snapshot across writer commits without taking a writer reservation', async () => {
    await store.put(entry())
    store.setMeta('status', 'before')
    const snapshot = SqliteStateStore.openReadOnlySnapshot(file)
    try {
      expect(await snapshot.transaction(async (tx) => tx.getMeta!('status'))).toBe('before')
      await store.transaction(async (tx) => {
        await tx.put(entry({ versionId: 'ver-2' }))
        await tx.setMeta!('status', 'after')
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
    const result = await store.transaction(async (tx) => {
      await tx.put(entry())
      await tx.setCursor(7)
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
      store.transaction(async (tx) => {
        await tx.put(entry({ path: 'notes/b.md', wirePath: 'notes/b.md', fileId: 'file-2' }))
        await tx.delete('notes/a.md')
        await tx.setCursor(99)
        await tx.setJournal(null)
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
    await store.transaction(async (tx) => {
      await tx.put(entry())
      await tx.transaction(async (tx) => {
        await tx.setCursor(5)
      })
    })
    expect(await store.get('notes/a.md')).toEqual(entry())
    expect(await store.getCursor()).toBe(5)
  })

  it('rolls the outer transaction back when a nested one throws through it', async () => {
    const boom = new Error('boom')
    await expect(
      store.transaction(async (tx) => {
        await tx.put(entry())
        await tx.transaction(async (tx) => {
          await tx.setCursor(5)
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
    await expect(store.transaction(async (tx) => undefined)).rejects.toMatchObject({ code: 'io' })
    store = SqliteStateStore.open(file)
  })

  it('reports a database another writer holds as a conflict', async () => {
    const other = SqliteStateStore.open(file, { busyTimeoutMs: 0 })
    // A scoped callback no longer reserves SQLite across awaits. Hold a real SQL
    // writer instead, so this still exercises the busy/error mapping guarantee.
    const writer = new SqliteDatabase(file)
    writer.exec('BEGIN IMMEDIATE')
    try {
      await expect(
        other.transaction(async (tx) => {
          await tx.setCursor(1)
        })
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
      other.close()
    }
    await store.put(entry())
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

  it('D-154 alias candidates track scoped writes, rollback and external commits', async () => {
    const candidates = async (s: typeof store) => {
      const found = []
      for await (const row of s.pathCandidates('NOTE.md')) found.push(row.path)
      return found
    }
    expect(await candidates(store)).toEqual([])
    await store.put({ ...entry(), path: 'Note.md' })
    expect(await candidates(store)).toEqual(['Note.md'])
    await expect(
      store.transaction(async (tx) => {
        await tx.delete('Note.md')
        await tx.put({ ...entry(), path: 'note.md' })
        const found = []
        for await (const row of tx.pathCandidates!('NOTE.md')) found.push(row.path)
        expect(found).toEqual(['note.md'])
        throw new Error('rollback')
      })
    ).rejects.toThrow('rollback')
    expect(await candidates(store)).toEqual(['Note.md'])
    const other = SqliteStateStore.open(file)
    try {
      await other.put({ ...entry(), path: 'note.md' })
      expect(await candidates(store)).toEqual(['note.md'])
    } finally {
      other.close()
    }
    await store.transaction(async (tx) => {
      await tx.delete('note.md')
    })
    expect(await candidates(store)).toEqual([])
  })

  it('D-154 indexes the supplied host key, including broader Unicode folding', async () => {
    const key = (path: string) => path.normalize('NFC').toLowerCase().replaceAll('ß', 'ss')
    await store.put({ ...entry(), path: 'straße.md' })
    const collect = async (state: typeof store | import('@abele/sync-core').StateStore) => {
      const paths = []
      for await (const row of state.pathCandidates!('STRASSE.md', key)) paths.push(row.path)
      return paths
    }
    expect(await collect(store)).toEqual(['straße.md'])
    await store.transaction(async (tx) => {
      await tx.delete('straße.md')
      await tx.put({ ...entry(), path: 'Straße.md' })
      expect(await collect(tx)).toEqual(['Straße.md'])
    })
    expect(await collect(store)).toEqual(['Straße.md'])
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
