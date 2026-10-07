import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { createGroupGrant, revokeGroupMember } from '../../src/auth/groupManagement.js'
import {
  inviteGroupMember,
  acceptGroupInvitation,
  enrolGroupInstallation,
} from '../../src/auth/groupInvitations.js'
import { readScopedState } from '../../src/scoped/state.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `group authority and recovery (${dialect})`,
    () => {
      it('requires fresh owner management and gives collaborators only exact recoverable scoped memberships/installations', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const root = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Project.md', 'root')])
          ).results[0]
          const input = {
            label: 'Project',
            root_file_id: root.file_id,
            expected_root_version: root.version_id,
            role: 'editor',
          }
          await expect(
            createGroupGrant(f.deps, f.device.deviceToken, f.vault, input)
          ).rejects.toMatchObject({ code: 'unauthorized' })
          const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, input)
          const recipient = await f.t.account(),
            wrong = await f.t.account()
          const invitation = await inviteGroupMember(
            f.deps,
            f.owner.accountToken,
            f.vault,
            grant.id,
            {
              intended_account_id: recipient.accountId,
              role: 'editor',
              expires_at: '2030-01-02T00:00:00.000Z',
            }
          )
          await expect(
            acceptGroupInvitation(f.deps, wrong.accountToken, invitation.invitation_token)
          ).rejects.toMatchObject({ code: 'forbidden' })
          const accepted = await acceptGroupInvitation(
            f.deps,
            recipient.accountToken,
            invitation.invitation_token
          )
          expect(
            await acceptGroupInvitation(f.deps, recipient.accountToken, invitation.invitation_token)
          ).toEqual(accepted)
          const enrol = {
            attempt_id: 'install-one',
            name: 'Recipient Mac',
            platform: 'desktop',
            role: 'editor',
            expires_at: '2030-01-02T00:00:00.000Z',
          }
          const install = await enrolGroupInstallation(
            f.deps,
            recipient.accountToken,
            grant.id,
            enrol
          )
          expect(install.installation_token).toMatch(/^absi_/)
          expect(
            await enrolGroupInstallation(f.deps, recipient.accountToken, grant.id, enrol)
          ).toEqual(install)
          expect(
            await f.t.db
              .selectFrom('vault_members')
              .select('account_id')
              .where('account_id', '=', recipient.accountId)
              .execute()
          ).toEqual([])
          expect(
            await f.t.db
              .selectFrom('devices')
              .select('id')
              .where('account_id', '=', recipient.accountId)
              .execute()
          ).toEqual([])
          await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
          await processGroupDirtyPage(f.deps, f.vault)
          expect(
            (await readScopedState(f.deps, install.installation_token, f.vault, grant.id))
              .principal_id
          ).toBe(install.installation_id)
          await revokeGroupMember(
            f.deps,
            f.owner.accountToken,
            f.vault,
            grant.id,
            accepted.member_id,
            0
          )
          await expect(
            enrolGroupInstallation(f.deps, recipient.accountToken, grant.id, enrol)
          ).rejects.toMatchObject({ code: 'forbidden' })
          await expect(
            acceptGroupInvitation(f.deps, recipient.accountToken, invitation.invitation_token)
          ).rejects.toMatchObject({ code: 'forbidden' })
          await expect(
            readScopedState(f.deps, install.installation_token, f.vault, grant.id)
          ).rejects.toMatchObject({ code: 'unauthorized' })
        } finally {
          await f.close()
        }
      })
    }
  )
