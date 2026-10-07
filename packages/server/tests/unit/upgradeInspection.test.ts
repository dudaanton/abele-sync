import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SqliteDatabase from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const script = join(root, 'scripts/upgrade-preflight.mjs')
async function fixture() {
  await mkdir(join(root, 'data'), { recursive: true })
  const dir = await mkdtemp(join(root, 'data/inspection-'))
  const evidence = join(dir, 'evidence.json')
  await writeFile(
    evidence,
    JSON.stringify({
      database: 'synthetic-inspection',
      sourceRevision: '68bb5bb893a98d2ec89b86cdc511805be6f7d229',
      writersStopped: true,
      collectorsStopped: true,
      databaseBackup: 'synthetic',
      blobBackup: 'synthetic',
    })
  )
  return { dir, evidence }
}
const inspect = (file: string, evidence: string) =>
  spawnSync(process.execPath, [script, evidence], {
    cwd: root,
    env: { ...process.env, ABELE_DATABASE_URL: `sqlite://${file}` },
    encoding: 'utf8',
  })

describe('read-only SQLite upgrade inspection', () => {
  it('fails a mistyped path without creating a file or parent directory', async () => {
    const { dir, evidence } = await fixture()
    try {
      const file = join(dir, 'mistyped', 'missing.db')
      const result = inspect(file, evidence)
      expect(result.status, result.stdout).not.toBe(0)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(dir, 'mistyped'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('does not switch DELETE journalling to WAL or change database bytes during inspection', async () => {
    const { dir, evidence } = await fixture()
    const file = join(dir, 'existing.db')
    const db = new SqliteDatabase(file)
    db.pragma('journal_mode = DELETE')
    db.exec(
      "create table kysely_migration (name text primary key,timestamp text not null); insert into kysely_migration values ('001_init','2030-01-01T00:00:00.000Z')"
    )
    db.close()
    try {
      const before = readFileSync(file),
        names = await readdir(dir)
      const result = inspect(file, evidence)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(file)).toEqual(before)
      expect(await readdir(dir)).toEqual(names)
      const check = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
      try {
        expect(check.pragma('journal_mode', { simple: true })).toBe('delete')
      } finally {
        check.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
