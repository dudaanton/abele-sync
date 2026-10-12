import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it, vi } from 'vitest'
import { runAdmin } from '../../src/admin-cli/index.js'
import { v2Server } from '../helpers/v2Server.js'
import { createUser } from '../../src/access/tokens.js'
import { verifyBackup } from '../../src/admin-cli/verifyBackup.js'

it('refuses a backup with an 011 journal but missing durable conflict identity', async () => {
  const t = await v2Server()
  try {
    await t.db.schema.dropTable('conflict_divergences').execute()
    const snapshot = join(t.dir, 'incomplete.db')
    await sql.raw(`vacuum into '${snapshot.replace(/'/g, "''")}'`).execute(t.db)
    await expect(
      verifyBackup(snapshot, t.store.dir, Buffer.from('ab'.repeat(32), 'hex'))
    ).rejects.toThrow(/conflict.*schema/)
  } finally {
    await t.close()
  }
})

const hook = vi.hoisted(() => ({ beforeCopy: null as (() => Promise<void>) | null }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    cp: async (...args: Parameters<typeof cp>) => {
      await hook.beforeCopy?.()
      return fs.cp(...args)
    },
  }
})
it('refuses success when GC removes a snapshot blob before the directory copy', async () => {
  const t = await v2Server()
  try {
    const root = await createUser(
      { db: t.db, pepper: t.config.tokenPepper },
      'Backup fixture',
      t.address
    )
    const space = (await t.db.selectFrom('spaces').select('id').executeTakeFirstOrThrow()).id
    const content = await t.store.put(Buffer.from('needed by the snapshot'))
    const at = root.info.created_at
    // The backup regression owns storage integrity, not an access or commit flow.
    // Seed the retained engine's exact current rows in a fresh token space.
    await t.db
      .insertInto('files')
      .values({
        id: 'f',
        vault_id: space,
        path: 'a.md',
        path_ci: 'a.md',
        kind: 'note',
        head_version_id: 'v',
        deleted_at: null,
      })
      .execute()
    await t.db
      .insertInto('versions')
      .values({
        id: 'v',
        file_id: 'f',
        vault_id: space,
        seq: 1,
        no: 1,
        op: 'create',
        path: 'a.md',
        path_ci: 'a.md',
        prev_path: null,
        blob_sha: content.sha,
        size: content.size,
        mtime: 1,
        actor_kind: 'key',
        actor_id: root.info.id,
        actor_name: 'Fixture',
        created_at: at,
        prev_version_id: null,
        merge: null,
        retention_class: 'notes',
      })
      .execute()
    await t.db.updateTable('vault_seq').set({ head_seq: 1 }).where('vault_id', '=', space).execute()
    const database = join(t.dir, 'live.db')
    await sql.raw(`vacuum into '${database.replace(/'/g, "''")}'`).execute(t.db)
    hook.beforeCopy = async () => {
      hook.beforeCopy = null
      await rm(t.store.pathFor(content.sha))
    }
    const errors: string[] = []
    const code = await runAdmin(
      ['backup', '--to', join(t.dir, 'backup')],
      {
        ABELE_DATABASE_URL: `sqlite://${database}`,
        ABELE_BLOB_DIR: t.store.dir,
        ABELE_MASTER_KEY: 'ab'.repeat(32),
        ABELE_TOKEN_PEPPER: t.config.tokenPepper,
      },
      { log: () => {}, error: (line) => errors.push(line) }
    )
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(content.sha)
  } finally {
    hook.beforeCopy = null
    await t.close()
  }
})
