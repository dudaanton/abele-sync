import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it, vi } from 'vitest'
import { runAdmin } from '../../src/admin-cli/index.js'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob } from '../helpers/ops.js'

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
  const t = await buildTestApp()
  try {
    const { accountToken } = await t.account(),
      { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const sha = await putBlob(t.app, deviceToken, 'needed by the snapshot')
    await commit(t.app, deviceToken, vaultId, [create('a.md', 'needed by the snapshot')])
    const db = join(t.dir, 'live.db')
    await sql.raw(`vacuum into '${db.replace(/'/g, "''")}'`).execute(t.db)
    hook.beforeCopy = async () => {
      hook.beforeCopy = null
      await rm(t.store.pathFor(sha))
    }
    const errors: string[] = []
    const code = await runAdmin(
      ['backup', '--to', join(t.dir, 'backup')],
      {
        ABELE_DATABASE_URL: `sqlite://${db}`,
        ABELE_BLOB_DIR: t.store.dir,
        ABELE_MASTER_KEY: 'ab'.repeat(32),
        ABELE_TOKEN_PEPPER: 'test',
      },
      { log: () => {}, error: (line) => errors.push(line) }
    )
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain(sha)
  } finally {
    hook.beforeCopy = null
    await t.close()
  }
})
