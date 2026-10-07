import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { commitScoped } from '../../src/scoped/commits.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`atomic modify ownership (${dialect})`, () => {
    it('keeps own same-SHA evidence until both identities are modified and consumes only that principal at unit completion', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'old')
        const heads = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/a.md', 'old'),
            create('Agents/b.md', 'old'),
          ])
        ).results
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        for (const key of [f.a, f.b])
          await uploadScopedBlob(
            f.deps,
            key.key_token,
            f.vault,
            f.grant.id,
            shaOf('new'),
            Buffer.from('new')
          )
        const ops = heads.map((head: any) => ({
          op: 'modify',
          file_id: head.file_id,
          base_version_id: head.version_id,
          sha: shaOf('new'),
          size: 3,
          mtime: 2,
        }))
        const first = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'same-sha-modifies',
          ops
        )
        expect(first.results).toHaveLength(2)
        expect(
          await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'same-sha-modifies', ops)
        ).toEqual(first)
        expect(
          (await f.t.db.selectFrom('scope_blob_uploads').select('principal_id').execute()).map(
            (row) => row.principal_id
          )
        ).toEqual([f.b.key_id])
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(4)
      } finally {
        await f.close()
      }
    })
  })
