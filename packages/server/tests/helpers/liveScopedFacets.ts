import { createGroupGrant } from '../../src/auth/groupManagement.js'
import {
  inviteGroupMember,
  acceptGroupInvitation,
  enrolGroupInstallation,
} from '../../src/auth/groupInvitations.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { readScopedState } from '../../src/scoped/state.js'
import { commit, create, putBlob } from './ops.js'
import type { scopedFixture } from './scopedFixture.js'
export async function liveScopedFacets(f: Awaited<ReturnType<typeof scopedFixture>>) {
  await putBlob(f.t.app, f.device.deviceToken, 'facet-root')
  const root = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [
      create('Project/FacetRoot.md', 'facet-root'),
    ])
  ).results[0]
  const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
    label: 'Facets',
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'editor',
  })
  const recipient = await f.t.account()
  const invite = await inviteGroupMember(f.deps, f.owner.accountToken, f.vault, grant.id, {
    intended_account_id: recipient.accountId,
    role: 'editor',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  await acceptGroupInvitation(f.deps, recipient.accountToken, invite.invitation_token)
  const installation = await enrolGroupInstallation(f.deps, recipient.accountToken, grant.id, {
    attempt_id: 'matrix-install',
    name: 'Matrix',
    platform: 'desktop',
    role: 'editor',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  const pending = await inviteGroupMember(f.deps, f.owner.accountToken, f.vault, grant.id, {
    role: 'reader',
    expires_at: '2030-01-02T00:00:00.000Z',
  })
  await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
  await processGroupDirtyPage(f.deps, f.vault)
  const state = await readScopedState(f.deps, installation.installation_token, f.vault, grant.id)
  if (state.principal_id !== installation.installation_id || state.state !== 'active')
    throw new Error('live installation fixture required')
  return {
    installationToken: installation.installation_token,
    invitationToken: pending.invitation_token,
  }
}
