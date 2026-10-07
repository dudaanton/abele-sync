import { describe, expect, it } from 'vitest'
import { sql, type KyselyPlugin } from 'kysely'
import { createDb } from '../../src/db/connect.js'
import {
  revokeDevice,
  revokeSelf,
  revokeVaultDevice,
  authenticateDevice,
} from '../../src/auth/devices.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { readIntrinsicSponsorProof } from '../../src/scoped/sponsorProof.js'
import { readSponsoredAssets, addSponsoredAsset } from '../../src/scoped/assets.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
const gate = () => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    release: () => resolve(),
  }
}
describe.skipIf(!hasPgTestDb)('owner device publication revocation fence', () => {
  for (const mode of ['account', 'self', 'sibling'] as const)
    it(`serializes ${mode} revocation behind final owner device read through commit without last_seen locking`, async () => {
      const f = await scopedFixture('pg'),
        other = createDb(f.t.databaseUrl!),
        entered = gate(),
        release = gate()
      let publishing: Promise<unknown> | undefined, revoking: Promise<unknown> | undefined
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'note')])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'image')
        const image = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Attachments/x.png', 'image'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const sponsor = (
            await readIntrinsicSponsorProof(
              f.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              note.file_id
            )
          ).sponsor,
          view = await readSponsoredAssets(f.deps, f.device.deviceToken, f.vault, f.grant.id)
        const own = await authenticateDevice(f.deps, f.device.deviceToken),
          sibling = await f.t.device(f.owner.accountToken, f.vault, 'sibling'),
          asking = await authenticateDevice(f.deps, sibling.deviceToken)
        await f.t.db
          .updateTable('devices')
          .set({ last_seen_at: f.deps.now().toISOString() })
          .where('id', '=', own.deviceId)
          .execute()
        let reads = 0
        const ids = new Set<object>(),
          plugin: KyselyPlugin = {
            transformQuery(args) {
              const raw = JSON.stringify(args.node)
              if (
                args.node.kind === 'SelectQueryNode' &&
                raw.includes('devices') &&
                raw.includes('accounts') &&
                ++reads === 3
              )
                ids.add(args.queryId)
              return args.node
            },
            async transformResult(args) {
              if (ids.has(args.queryId)) {
                entered.release()
                await release.promise
              }
              return args.result
            },
          }
        const input = {
          grantId: f.grant.id,
          expectedRevision: view.revision,
          withdrawalGeneration: view.withdrawalGeneration,
          intentId: 'race',
          decisionDeviceId: own.deviceId,
          target: {
            fileId: image.file_id,
            versionId: image.version_id,
            sha: shaOf('image'),
            path: 'Attachments/x.png',
            eligible: true,
          },
          sponsors: [sponsor],
          reason: 'confirmed-existing',
        }
        publishing = addSponsoredAsset(
          { ...f.deps, db: f.t.db.withPlugin(plugin) },
          f.device.deviceToken,
          f.vault,
          f.grant.id,
          input
        )
        await entered.promise
        const bound = { ...f.deps, db: other.db }
        revoking =
          mode === 'account'
            ? revokeDevice(bound, f.owner.accountId, own.deviceId)
            : mode === 'self'
              ? revokeSelf(bound, own)
              : revokeVaultDevice(bound, asking, own.deviceId)
        let waiting = false
        for (let n = 0; n < 100; n++) {
          const result =
            await sql`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
              f.t.db
            )
          if (result.rows.length) {
            waiting = true
            break
          }
          await new Promise((r) => setTimeout(r, 5))
        }
        expect(waiting).toBe(true)
        release.release()
        await publishing
        await revoking
        await expect(
          addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.grant.id, input)
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        release.release()
        await Promise.allSettled([publishing, revoking].filter(Boolean))
        await other.close()
        await f.close()
      }
    })
})
