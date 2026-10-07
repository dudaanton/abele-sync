import { expect, it } from 'vitest'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetention } from '../../src/history/retention.js'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob } from '../helpers/ops.js'

it.each([true, false])(
  'recovers an interrupted tombstone with bytes present=%s',
  async (present) => {
    const t = await buildTestApp()
    try {
      const { sha, size } = await t.store.put(Buffer.from('recoverable'))
      const at = new Date().toISOString()
      await t.db
        .insertInto('blobs')
        .values({
          sha,
          size,
          refs: -1,
          storage_ref: t.store.pathFor(sha),
          created_at: at,
          last_referenced_at: at,
        })
        .execute()
      if (!present) await t.store.delete(sha)
      const config = loadConfig({
        ABELE_MASTER_KEY: 'ab'.repeat(32),
        ABELE_TOKEN_PEPPER: 'test',
        ABELE_BLOB_DIR: t.store.dir,
      })
      await runRetention({
        db: t.db,
        store: t.store,
        dialect: 'sqlite',
        uploads: createUploadManager({ db: t.db, store: t.store, config }),
        now: () => new Date(),
        idempotencyTtlMs: 86400000,
      })
      expect(
        await t.db.selectFrom('blobs').selectAll().where('sha', '=', sha).executeTakeFirst()
      ).toBeUndefined()
      const { accountToken } = await t.account(),
        { vaultId } = await t.vault(accountToken)
      const { deviceToken } = await t.device(accountToken, vaultId)
      await putBlob(t.app, deviceToken, 'recoverable')
      expect(
        (await commit(t.app, deviceToken, vaultId, [create('a.md', 'recoverable')])).results[0]
          .status
      ).toBe('applied')
    } finally {
      await t.close()
    }
  }
)
