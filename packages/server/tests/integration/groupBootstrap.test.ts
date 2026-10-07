import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareGroupBootstrap, rebuildGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`paged group bootstrap (${dialect})`, () => {
    it('captures a frozen inventory in bounded durable pages and replays edits without restarting the scan', async () => {
      const f = await scopedFixture(dialect)
      try {
        const body = '---\ngroups: ["[[Root]]"]\n---\nbody'
        await putBlob(f.t.app, f.device.deviceToken, body)
        const member = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Root.md', body),
            create('Member.md', body),
          ])
        ).results[1]
        await f.t.db
          .updateTable('scope_grants')
          .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
          .where('id', '=', f.grant.id)
          .execute()
        expect((await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1)).phase).toBe(
          'capture'
        )
        const frozen = (
          await f.t.db
            .selectFrom('scope_group_progress')
            .select('bootstrap_start_seq')
            .executeTakeFirstOrThrow()
        ).bootstrap_start_seq
        await putBlob(f.t.app, f.device.deviceToken, 'body')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: member.file_id,
            base_version_id: member.version_id,
            sha: shaOf('body'),
            size: 4,
            mtime: 2,
          },
        ])
        expect((await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1)).phase).toBe(
          'replay'
        )
        expect(
          (
            await f.t.db
              .selectFrom('scope_group_progress')
              .select('bootstrap_start_seq')
              .executeTakeFirstOrThrow()
          ).bootstrap_start_seq
        ).toBe(frozen)
        expect((await processGroupDirtyPage(f.deps, f.vault, 10)).ready).toBe(true)
        const facts = await f.t.db
          .selectFrom('scope_group_parse_facts')
          .select('facts')
          .where('file_id', '=', member.file_id)
          .orderBy('committed_seq', 'desc')
          .executeTakeFirstOrThrow()
        expect(JSON.parse(facts.facts).active).toEqual([])
      } finally {
        await f.close()
      }
    })
    it('refuses an expired capture lease instead of silently renewing unknown history', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Root.md', 'note'),
          create('Other.md', 'note'),
        ])
        await f.t.db
          .updateTable('scope_grants')
          .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
          .where('id', '=', f.grant.id)
          .execute()
        await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1)
        await f.t.db
          .updateTable('scope_group_leases')
          .set({ created_at: '2029-12-31T23:55:00.000Z', expires_at: '2030-01-01T00:00:00.000Z' })
          .execute()
        await expect(
          prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1)
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
        await expect(
          rebuildGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1)
        ).rejects.toMatchObject({ code: 'conflict' })
        expect(await rebuildGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 0)).toEqual({
          generation: 1,
        })
        await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1000)
        expect((await processGroupDirtyPage(f.deps, f.vault, 1000)).ready).toBe(true)
      } finally {
        await f.close()
      }
    })
  })
