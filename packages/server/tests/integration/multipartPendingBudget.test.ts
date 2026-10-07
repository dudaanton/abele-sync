import { describe, expect, it } from 'vitest'
import {
  beginScopedUpload,
  putScopedPart,
  completeScopedUpload,
} from '../../src/scoped/multipart.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { shaOf } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `multipart uncommitted budget (${dialect})`,
    () => {
      it('cannot accumulate more than 64 completed entitlements through sequential completion', async () => {
        const f = await scopedFixture(dialect)
        try {
          for (let i = 0; i < 64; i++) {
            const bytes = Buffer.from(`small-${i}`),
              sha = shaOf(bytes)
            const started = await beginScopedUpload(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              sha,
              bytes.length
            )
            await putScopedPart(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              started.upload_id,
              0,
              bytes
            )
            await completeScopedUpload(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              started.upload_id
            )
          }
          await expect(
            beginScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, shaOf('another'), 7)
          ).rejects.toMatchObject({ code: 'quota_waiting' })
          await expect(
            beginScopedUpload(f.deps, f.b.key_token, f.vault, f.grant.id, shaOf('another'), 7)
          ).resolves.toBeDefined()
        } finally {
          await f.close()
        }
      })
      it('counts live completed bytes together with in-progress reservations, ignoring expired own entitlements', async () => {
        const f = await scopedFixture(dialect)
        try {
          await f.t.db
            .insertInto('scope_blob_uploads')
            .values({
              vault_id: f.vault,
              grant_id: f.grant.id,
              principal_kind: 'key',
              principal_id: f.a.key_id,
              key_id: f.a.key_id,
              installation_id: null,
              sha: shaOf('synthetic-large'),
              size: 200 * 1024 * 1024,
              created_at: f.deps.now().toISOString(),
              expires_at: '2030-01-02T00:00:00.000Z',
            })
            .execute()
          await expect(
            beginScopedUpload(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              shaOf('57MiB'),
              57 * 1024 * 1024
            )
          ).rejects.toMatchObject({ code: 'quota_waiting' })
          await f.t.db
            .updateTable('scope_blob_uploads')
            .set({ expires_at: '2029-12-31T00:00:00.000Z' })
            .execute()
          await expect(
            beginScopedUpload(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              shaOf('57MiB'),
              57 * 1024 * 1024
            )
          ).resolves.toBeDefined()
        } finally {
          await f.close()
        }
      })
      it('rechecks completion and one-shot publication against shared reservations under the authority fence', async () => {
        const f = await scopedFixture(dialect)
        try {
          const bytes = Buffer.from('finish'),
            sha = shaOf(bytes)
          const started = await beginScopedUpload(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            sha,
            bytes.length
          )
          await putScopedPart(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            started.upload_id,
            0,
            bytes
          )
          await f.t.db
            .insertInto('scope_blob_uploads')
            .values(
              Array.from({ length: 64 }, (_, i) => ({
                vault_id: f.vault,
                grant_id: f.grant.id,
                principal_kind: 'key' as const,
                principal_id: f.a.key_id,
                key_id: f.a.key_id,
                installation_id: null,
                sha: shaOf(`reserved-${i}`),
                size: 1,
                created_at: f.deps.now().toISOString(),
                expires_at: '2030-01-02T00:00:00.000Z',
              }))
            )
            .execute()
          await expect(
            completeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, started.upload_id)
          ).rejects.toMatchObject({ code: 'quota_waiting' })
          await f.t.db.deleteFrom('scope_blob_uploads').execute()
          await beginScopedUpload(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('reserve-200'),
            200 * 1024 * 1024
          )
          await beginScopedUpload(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('reserve-56'),
            56 * 1024 * 1024 - bytes.length
          )
          await expect(
            uploadScopedBlob(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              shaOf('one'),
              Buffer.from('one')
            )
          ).rejects.toMatchObject({ code: 'quota_waiting' })
        } finally {
          await f.close()
        }
      })
    }
  )
}
