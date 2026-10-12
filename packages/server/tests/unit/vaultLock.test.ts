import { expect, it } from 'vitest'
import { tempDb } from '../helpers/tempDb.js'
import { withVaultLock } from '../../src/oplog/lock.js'

it('retries the whole SQLite transaction on busy snapshots, with rollback and a bounded budget', async () => {
  const handle = await tempDb()
  try {
    let attempts = 0
    await withVaultLock(handle.db, 'sqlite', 'lock-test', async (tx) => {
      await tx.insertInto('vault_seq').values({ vault_id: 'lock-test', head_seq: 1 }).execute()
      if (++attempts < 3)
        throw Object.assign(new Error('busy snapshot'), { code: 'SQLITE_BUSY_SNAPSHOT' })
    })
    expect(attempts).toBe(3)
    expect(await handle.db.selectFrom('vault_seq').selectAll().execute()).toHaveLength(1)
    let bounded = 0
    await expect(
      withVaultLock(handle.db, 'sqlite', 'lock-test', async () => {
        bounded++
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })
      })
    ).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    expect(bounded).toBeGreaterThan(1)
    expect(bounded).toBeLessThanOrEqual(8)
  } finally {
    await handle.close()
  }
})
