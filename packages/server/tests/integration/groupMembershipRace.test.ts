import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { createDb } from '../../src/db/connect.js'
import { withOwnerManagement } from '../../src/auth/freshOwner.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import {
  inviteGroupMember,
  acceptGroupInvitation,
  enrolGroupInstallation,
} from '../../src/auth/groupInvitations.js'
import { commit, create, putBlob } from '../helpers/ops.js'
const gate = () => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    release: () => resolve(),
  }
}
it.skipIf(!hasPgTestDb)(
  'does not issue an installation after another PostgreSQL pool revokes the parent while enrolment waits',
  async () => {
    const f = await scopedFixture('pg'),
      other = createDb(f.t.databaseUrl!),
      entered = gate(),
      release = gate()
    let revoking: Promise<unknown> | undefined, enrolling: Promise<unknown> | undefined
    try {
      await putBlob(f.t.app, f.device.deviceToken, 'root')
      const root = (
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
      ).results[0]
      const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
        label: 'Root',
        root_file_id: root.file_id,
        expected_root_version: root.version_id,
        role: 'editor',
      })
      const recipient = await f.t.account(),
        invite = await inviteGroupMember(f.deps, f.owner.accountToken, f.vault, grant.id, {
          intended_account_id: recipient.accountId,
          role: 'editor',
          expires_at: '2030-01-02T00:00:00.000Z',
        })
      const member = await acceptGroupInvitation(
        f.deps,
        recipient.accountToken,
        invite.invitation_token
      )
      revoking = withOwnerManagement(
        { ...f.deps, db: other.db },
        f.owner.accountToken,
        f.vault,
        async (tx) => {
          entered.release()
          await release.promise
          await tx
            .updateTable('scope_members')
            .set({ revoked_at: f.deps.now().toISOString() })
            .where('id', '=', member.member_id)
            .execute()
        },
        [recipient.accountId]
      )
      await entered.promise
      enrolling = enrolGroupInstallation(f.deps, recipient.accountToken, grant.id, {
        attempt_id: 'race',
        name: 'Recipient',
        platform: 'desktop',
        role: 'editor',
      })
      const rejected = expect(enrolling).rejects.toMatchObject({ code: 'forbidden' })
      let waiting = false
      for (let i = 0; i < 100; i++) {
        if (
          (
            await sql`select 1 from pg_locks where locktype='advisory' and not granted and pid in(select pid from pg_stat_activity where datname=current_database())`.execute(
              f.t.db
            )
          ).rows.length
        ) {
          waiting = true
          break
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(waiting).toBe(true)
      release.release()
      await revoking
      await rejected
      expect(await f.t.db.selectFrom('scope_installations').select('id').execute()).toEqual([])
    } finally {
      release.release()
      await Promise.allSettled([revoking, enrolling].filter(Boolean))
      await other.close()
      await f.close()
    }
  }
)
