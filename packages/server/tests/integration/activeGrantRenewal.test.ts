import { describe, expect, it } from 'vitest'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { updateFolderGrant } from '../../src/auth/folderManagement.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`active grant renewal (${dialect})`, () => {
    it('preserves current intervals through active expiry renewal and unchanged selector/role updates', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const before = await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          head.file_id,
          head.version_id
        )
        let revision = 0
        for (const change of [
          { expires_at: '2030-01-03T00:00:00.000Z' },
          { role: 'editor' },
          { prefix: 'Agents/' },
        ]) {
          await updateFolderGrant(f.deps, f.owner.accountToken, f.vault, f.grant.id, {
            expected_revision: revision++,
            ...change,
          })
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          expect(
            (
              await requireFolderVersion(
                f.deps,
                f.a.key_token,
                f.vault,
                f.grant.id,
                head.file_id,
                head.version_id
              )
            ).interval_id
          ).toBe(before.interval_id)
        }
      } finally {
        await f.close()
      }
    })
  })
}
