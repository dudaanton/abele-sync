import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql, type KyselyPlugin, type RootOperationNode } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/db/connect.js'
import { runMigrations } from '../../src/db/migrate.js'
import { authorityStatements } from '../../src/db/migrations/008_scoped_authority.js'
import { viewStatements } from '../../src/db/migrations/009_scoped_views.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import {
  authority,
  hardening,
  personalRows,
  populated007,
  seedAuthority,
  views,
} from '../helpers/scopedMigration.js'

const child = fileURLToPath(new URL('../helpers/scopedMigrationKill.mjs', import.meta.url))
const scratch = fileURLToPath(new URL('../../../../data/', import.meta.url))
function migrationWrite(node: RootOperationNode): boolean {
  return (
    node.kind === 'AlterTableNode' ||
    (node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('kysely_migration')) ||
    (node.kind === 'RawNode' &&
      /^\s*(create|insert|alter|drop)\b/i.test(node.sqlFragments.join('')))
  )
}
function failAt(step: number): KyselyPlugin {
  let seen = 0
  return {
    transformQuery({ node }) {
      if (migrationWrite(node) && ++seen === step)
        throw new Error(`fault at migration write ${step}`)
      return node
    },
    async transformResult({ result }) {
      return result
    },
  }
}
const releases = [
  {
    target: authority,
    prior: hardening,
    steps: authorityStatements.length + 2,
    absent: 'scope_grants',
    cuts: ['create table scope_grants', 'insert into account_authority', 'journal'],
  },
  {
    target: views,
    prior: authority,
    steps: viewStatements.length + 1,
    absent: 'scope_snapshots',
    cuts: ['create table scope_snapshot_items', 'insert into scope_feed_state', 'journal'],
  },
]

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`upgrade crash matrix (${dialect})`, () => {
    for (const release of releases) {
      for (let step = 1; step <= release.steps; step++) {
        it(`${release.target}: rollback/retry at DDL/copy/journal write ${step}/${release.steps}`, async () => {
          const t = await populated007(dialect)
          try {
            if (release.prior === authority) {
              await runMigrations(t.db, t.schema, authority)
              await seedAuthority(t.db)
            }
            const before = await personalRows(t.db)
            await expect(
              runMigrations(t.db.withPlugin(failAt(step)), t.schema, release.target)
            ).rejects.toThrow()
            expect(
              (await sql`select name from kysely_migration order by name`.execute(t.db)).rows.at(-1)
            ).toEqual({ name: release.prior })
            await expect(
              sql`select * from ${sql.table(release.absent)}`.execute(t.db)
            ).rejects.toThrow()
            expect(await personalRows(t.db)).toEqual(before)
            await runMigrations(t.db, t.schema, release.target)
            expect(await personalRows(t.db)).toEqual(before)
          } finally {
            await t.close()
          }
        })
      }
      for (const boundary of release.cuts) {
        it(`${release.target}: real SIGKILL after ${boundary}, new connection recovers journal and populated data`, async () => {
          await mkdir(scratch, { recursive: true })
          const dir = await mkdtemp(join(scratch, 'migration-kill-'))
          const t = await populated007(dialect)
          try {
            if (release.prior === authority) {
              await runMigrations(t.db, t.schema, authority)
              await seedAuthority(t.db)
            }
            const before = await personalRows(t.db)
            let url = t.url
            if (dialect === 'sqlite') {
              const file = join(dir, 'fixture.db')
              await sql`vacuum into ${file}`.execute(t.db)
              url = `sqlite://${file}`
            }
            expect(url).toBeDefined()
            const killed = spawnSync(process.execPath, [child, url!, release.target, boundary], {
              encoding: 'utf8',
              timeout: 8000,
            })
            expect(killed.signal, killed.stderr).toBe('SIGKILL')
            const restarted = createDb(url!)
            try {
              expect(
                (
                  await sql`select name from kysely_migration order by name`.execute(restarted.db)
                ).rows.at(-1)
              ).toEqual({ name: release.prior })
              expect(await personalRows(restarted.db)).toEqual(before)
              await runMigrations(restarted.db, undefined, release.target)
              await runMigrations(restarted.db, undefined, release.target)
              expect(await personalRows(restarted.db)).toEqual(before)
            } finally {
              await restarted.close()
            }
          } finally {
            await t.close()
            await rm(dir, { recursive: true, force: true })
          }
        })
      }
    }
  })
}
