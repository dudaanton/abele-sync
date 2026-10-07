import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { approveGroupRelation } from '../../src/auth/groupApprovals.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`explicit group approval (${dialect})`, () => {
    it('records a fresh owner-personal exact rebind without mutating immutable parsed origins', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'root')
        const root = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
        ).results[0]
        const body = '---\ngroups: ["[[Root]]"]\n---\nmember'
        await putBlob(f.t.app, f.device.deviceToken, body)
        const member = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Member.md', body)])
        ).results[0]
        const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
          label: 'Root',
          root_file_id: root.file_id,
          expected_root_version: root.version_id,
          role: 'editor',
        })
        await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
        await processGroupDirtyPage(f.deps, f.vault)
        const before = (
          await f.t.db
            .selectFrom('scope_group_parse_facts')
            .select('facts')
            .where('version_id', '=', member.version_id)
            .executeTakeFirstOrThrow()
        ).facts
        const originalBinding = await f.t.db
          .selectFrom('scope_group_bindings')
          .selectAll()
          .where('source_file_id', '=', member.file_id)
          .where('token_key', '=', 'root.md')
          .executeTakeFirstOrThrow()
        const request = {
          device_token: f.device.deviceToken,
          expected_revision: 0,
          source_file_id: member.file_id,
          source_version_id: member.version_id,
          target_file_id: root.file_id,
          target_version_id: root.version_id,
          token_key: 'root.md',
          anchor: true,
        }
        await expect(
          approveGroupRelation(f.deps, f.a.key_token, f.vault, grant.id, request)
        ).rejects.toMatchObject({ code: 'unauthorized' })
        await approveGroupRelation(f.deps, f.owner.accountToken, f.vault, grant.id, request)
        expect(
          (
            await f.t.db
              .selectFrom('scope_group_parse_facts')
              .select('facts')
              .where('version_id', '=', member.version_id)
              .executeTakeFirstOrThrow()
          ).facts
        ).toBe(before)
        expect(
          (
            await f.t.db
              .selectFrom('scope_group_bindings')
              .select('approved_rebind_id')
              .where('source_file_id', '=', member.file_id)
              .where('approved_rebind_id', 'is not', null)
              .executeTakeFirstOrThrow()
          ).approved_rebind_id
        ).not.toBeNull()
        expect(
          await f.t.db
            .selectFrom('scope_group_bindings')
            .selectAll()
            .where('source_file_id', '=', member.file_id)
            .where('token_key', '=', 'root.md')
            .executeTakeFirstOrThrow()
        ).toEqual(originalBinding)
        const approval = await f.t.db
          .selectFrom('scope_group_bindings')
          .select('approved_rebind_id')
          .where('source_file_id', '=', member.file_id)
          .where('approved_rebind_id', 'is not', null)
          .executeTakeFirstOrThrow()
        expect(JSON.parse(approval.approved_rebind_id!).grantId).toBe(grant.id)
      } finally {
        await f.close()
      }
    })
  })
