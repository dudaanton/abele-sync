import { describe, expect, it } from 'vitest'
import {
  beginScopedUpload,
  putScopedPart,
  completeScopedUpload,
} from '../../src/scoped/multipart.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { shaOf } from '../helpers/ops.js'
import { api } from '../helpers/client.js'
import { TEST_PASSWORD } from '../helpers/testApp.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `multipart quota replacement (${dialect})`,
    () => {
      it('completes a 6 MiB reservation within a 10 MiB quota without counting itself twice, retaining other reservations', async () => {
        const f = await scopedFixture(dialect)
        try {
          await api(f.t.app, f.device.deviceToken).patch(`/v1/vaults/${f.vault}/settings`, {
            quota_bytes: 10 * 1024 * 1024,
            account_password: TEST_PASSWORD,
          })
          const bytes = Buffer.alloc(6 * 1024 * 1024, 1),
            sha = shaOf(bytes)
          const upload = await beginScopedUpload(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            sha,
            bytes.length
          )
          for (let i = 0; i < upload.parts; i++)
            await putScopedPart(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              upload.upload_id,
              i,
              bytes.subarray(i * upload.part_size, (i + 1) * upload.part_size)
            )
          await f.t.db
            .insertInto('scope_uploads')
            .values({
              id: 'other',
              vault_id: f.vault,
              grant_id: f.grant.id,
              principal_kind: 'key',
              principal_id: f.b.key_id,
              key_id: f.b.key_id,
              installation_id: null,
              sha: shaOf('other'),
              size: 5 * 1024 * 1024,
              part_size: 1024 * 1024,
              parts_received: '[]',
              created_at: f.deps.now().toISOString(),
              expires_at: '2030-01-02T00:00:00.000Z',
              completing_at: null,
            })
            .execute()
          await expect(
            completeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, upload.upload_id)
          ).rejects.toMatchObject({ code: 'quota_waiting' })
          await f.t.db.deleteFrom('scope_uploads').where('id', '=', 'other').execute()
          expect(
            await completeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, upload.upload_id)
          ).toEqual({ sha, size: bytes.length })
          expect(await f.t.db.selectFrom('scope_uploads').select('id').execute()).toHaveLength(0)
          expect(await f.t.db.selectFrom('scope_blob_uploads').select('sha').execute()).toEqual([
            { sha },
          ])
        } finally {
          await f.close()
        }
      })
    }
  )
