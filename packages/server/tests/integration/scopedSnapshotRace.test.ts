import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/db/connect.js'
import { updateFolderKey } from '../../src/auth/folderManagement.js'
import { openFolderSnapshot, readFolderSnapshotPage } from '../../src/scoped/snapshots.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob } from '../helpers/ops.js'

describe.skipIf(!hasPgTestDb)('snapshot delivery across independent PostgreSQL pools', () => {
  it('refuses a subsequent page after another pool committed credential revocation', async () => {
    const f = await scopedFixture('pg'),
      other = createDb(f.t.databaseUrl!)
    try {
      await putBlob(f.t.app, f.device.deviceToken, 'note')
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        create('Agents/a.md', 'note'),
        create('Agents/b.md', 'note'),
      ])
      await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
      const first = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
      await updateFolderKey(
        { ...f.deps, db: other.db },
        f.owner.accountToken,
        f.vault,
        f.grant.id,
        f.a.key_id,
        { expected_revision: 0, revoke: true }
      )
      await expect(
        readFolderSnapshotPage(f.deps, f.a.key_token, f.vault, f.grant.id, first.next_cursor!)
      ).rejects.toMatchObject({ code: 'unauthorized' })
      const otherPrincipal = await openFolderSnapshot(f.deps, f.b.key_token, f.vault, f.grant.id, 1)
      expect(otherPrincipal.items).toHaveLength(1)
    } finally {
      await other.close()
      await f.close()
    }
  })
})
