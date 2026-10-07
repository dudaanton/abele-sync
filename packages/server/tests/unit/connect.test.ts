import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { createDb, parseInt8 } from '../../src/db/connect.js'
import type { Database } from '../../src/db/schema.js'

const tempDirs: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'abele-connect-'))
  tempDirs.push(dir)
  return dir
}

async function pragma(db: Kysely<Database>, name: string): Promise<unknown> {
  const { rows } = await sql.raw(`pragma ${name}`).execute(db)
  return Object.values(rows[0] as Record<string, unknown>)[0]
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('createDb', () => {
  it('opens an in-memory sqlite database', async () => {
    const { db, dialect, close } = createDb('sqlite::memory:')
    expect(dialect).toBe('sqlite')
    const { rows } = await sql<{ one: number }>`select 1 as one`.execute(db)
    expect(rows[0]?.one).toBe(1)
    await close()
  })

  it('skips WAL for an in-memory database but still sets the other pragmas', async () => {
    const { db, close } = createDb('sqlite::memory:')
    expect(await pragma(db, 'journal_mode')).toBe('memory')
    expect(await pragma(db, 'foreign_keys')).toBe(1)
    expect(await pragma(db, 'busy_timeout')).toBe(5000)
    await close()
  })

  it('creates the parent directory of an absolute sqlite path and sets the pragmas', async () => {
    const file = join(tempRoot(), 'nested', 'a.db')
    const { db, dialect, close } = createDb(`sqlite://${file}`)
    expect(dialect).toBe('sqlite')
    expect(await pragma(db, 'journal_mode')).toBe('wal')
    expect(await pragma(db, 'foreign_keys')).toBe(1)
    expect(await pragma(db, 'busy_timeout')).toBe(5000)
    await close()
    expect(existsSync(file)).toBe(true)
  })

  it('resolves a relative sqlite path against the working directory', async () => {
    const root = tempRoot()
    const cwd = process.cwd()
    process.chdir(root)
    try {
      const { db, close } = createDb('sqlite://rel/path.db')
      await sql`select 1`.execute(db)
      await close()
    } finally {
      process.chdir(cwd)
    }
    expect(existsSync(join(root, 'rel', 'path.db'))).toBe(true)
  })

  it('builds a postgres pool without connecting', async () => {
    for (const url of ['postgres://u:p@h/db', 'postgresql://u:p@h/db']) {
      const { dialect, close } = createDb(url)
      expect(dialect).toBe('pg')
      // close() is safe here: pg's Pool.end() resolves at once when no client was ever checked out.
      await close()
    }
  })

  it('rejects a url it does not understand', () => {
    for (const url of ['mysql://x', 'sqlite:/x', '', 'sqlite://']) {
      expect(() => createDb(url)).toThrow(/unsupported database url/)
    }
  })
})

describe('parseInt8', () => {
  it('reads a Postgres bigint as a number', () => {
    expect(parseInt8('1790428645718')).toBe(1_790_428_645_718)
    expect(parseInt8('3221225472')).toBe(3 * 2 ** 30)
    expect(parseInt8('-5')).toBe(-5)
  })

  it('refuses one a number would round, rather than read it wrong', () => {
    expect(() => parseInt8('9007199254740993')).toThrow(/does not fit/)
  })
})
