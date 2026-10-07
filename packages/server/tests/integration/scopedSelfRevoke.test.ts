import { describe, expect, it } from 'vitest'
import { revokeScopedSelf } from '../../src/scoped/selfRevoke.js'
import { readScopedState } from '../../src/scoped/state.js'
import { uploadScopedBlob, requireScopedUpload } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { shaOf } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped self revoke (${dialect})`, () => {
    it('retires only its own machine credential and entitlements, with idempotent metadata-only recovery', async () => {
      const f = await scopedFixture(dialect)
      try {
        for (const key of [f.a, f.b])
          await uploadScopedBlob(
            f.deps,
            key.key_token,
            f.vault,
            f.grant.id,
            shaOf('same'),
            Buffer.from('same')
          )
        expect(await revokeScopedSelf(f.deps, f.a.key_token, f.vault, f.grant.id)).toEqual({
          revoked: true,
        })
        expect(await revokeScopedSelf(f.deps, f.a.key_token, f.vault, f.grant.id)).toEqual({
          revoked: true,
        })
        expect(
          await f.t.db
            .selectFrom('audit')
            .select('id')
            .where('action', '=', 'scope.self.revoke')
            .execute()
        ).toHaveLength(1)
        await expect(
          readScopedState(f.deps, f.a.key_token, f.vault, f.grant.id)
        ).rejects.toMatchObject({ code: 'unauthorized' })
        await expect(
          requireScopedUpload(f.deps, f.b.key_token, f.vault, f.grant.id, shaOf('same'))
        ).resolves.toBeDefined()
        expect(
          (await f.t.db.selectFrom('scope_blob_uploads').select('principal_id').execute()).map(
            (row) => row.principal_id
          )
        ).toEqual([f.b.key_id])
        await expect(
          revokeScopedSelf(f.deps, f.device.deviceToken, f.vault, f.grant.id)
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
  })
