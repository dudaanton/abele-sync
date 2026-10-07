import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { reduceGroupOrigins } from '../../src/scoped/groups/origins.js'
import { storeGroupOrigins } from '../../src/scoped/groups/originStore.js'
import { bindGroupToken } from '../../src/scoped/groups/bindings.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`stable group targets (${dialect})`, () => {
    it('never resolves an old unresolved token on file arrival or jumps a bound token to a replacement identity', async () => {
      const f = await scopedFixture(dialect)
      try {
        const origin = reduceGroupOrigins({
          versionId: 'origin',
          ownerAccountId: f.owner.accountId,
          writer: {
            facet: 'device',
            principalId: f.device.deviceId,
            accountId: f.owner.accountId,
            grantId: null,
          },
          operation: 'modify',
          status: 'valid',
          tokens: [{ key: 'projects/root', targetId: null }],
        })
        const saved = await f.t.db
          .transaction()
          .execute((tx) =>
            storeGroupOrigins(tx, f.vault, 'source', origin, f.deps.now().toISOString())
          )
        const id = saved.memory['projects/root']!.origin.id
        const bind = (key: string, path: string) =>
          f.t.db.transaction().execute((tx) => bindGroupToken(tx, f.vault, 'source', key, id, path))
        expect((await bind('projects/root', 'Projects/Root')).state).toBe('unresolved')
        await putBlob(f.t.app, f.device.deviceToken, 'root')
        const root = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Projects/Root.md', 'root')])
        ).results[0]
        expect((await bind('projects/root', 'Projects/Root')).state).toBe('unresolved')
        expect((await bind('new-root', 'Projects/Root')).target_file_id).toBe(root.file_id)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          { op: 'delete', file_id: root.file_id, base_version_id: root.version_id },
        ])
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Projects/Root.md', 'root')])
        const retained = await bind('new-root', 'Projects/Root')
        expect(retained).toMatchObject({ state: 'tombstoned', target_file_id: root.file_id })
        expect((await bind('shorthand', 'Root')).state).toBe('unresolved')
      } finally {
        await f.close()
      }
    })
  })
