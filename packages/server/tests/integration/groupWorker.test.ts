import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { commit as personalCommit } from '../../src/oplog/commit.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`incremental group worker (${dialect})`, () => {
    it('processes bounded committed versions in order and never upgrades recipient groups on an owner re-save', async () => {
      const f = await scopedFixture(dialect)
      try {
        await f.t.db
          .updateTable('scope_grants')
          .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
          .where('id', '=', f.grant.id)
          .execute()
        await putBlob(f.t.app, f.device.deviceToken, 'root')
        const root = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')])
        ).results[0]
        const body = '---\ngroups: ["[[Root]]"]\n---\nrecipient'
        await putBlob(f.t.app, f.device.deviceToken, body)
        // Authenticated-writer fixture for the server-internal pipeline; external
        // group routes are deliberately still closed until later acceptance.
        const recipient = (
          await personalCommit(
            {
              ...f.deps,
              writer: {
                kind: 'key',
                facet: 'scoped',
                principal_id: f.a.key_id,
                account_id: f.owner.accountId,
                vault_id: f.vault,
                grant_id: f.grant.id,
              },
            },
            f.vault,
            { kind: 'key', id: f.a.key_id, name: 'Recipient' },
            [create('Member.md', body)]
          )
        ).results[0]!
        if (recipient.status === 'rejected') throw new Error('recipient fixture rejected')
        await putBlob(f.t.app, f.device.deviceToken, body + '\nowner body')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: recipient.file_id,
            base_version_id: recipient.version_id,
            sha: shaOf(body + '\nowner body'),
            size: Buffer.byteLength(body + '\nowner body'),
            mtime: 2,
          },
        ])
        expect((await processGroupDirtyPage(f.deps, f.vault, 1)).processed).toBe(1)
        expect((await processGroupDirtyPage(f.deps, f.vault, 1)).processed).toBe(1)
        expect((await processGroupDirtyPage(f.deps, f.vault, 1)).processed).toBe(1)
        const facts = await f.t.db
          .selectFrom('scope_group_parse_facts')
          .selectAll()
          .where('file_id', '=', recipient.file_id)
          .orderBy('committed_seq')
          .execute()
        expect(facts).toHaveLength(2)
        for (const fact of facts)
          expect(JSON.parse(fact.facts).memory['root.md'].origin.kind).toBe('recipient')
        expect(
          (
            await f.t.db
              .selectFrom('scope_group_bindings')
              .selectAll()
              .where('source_file_id', '=', recipient.file_id)
              .executeTakeFirstOrThrow()
          ).target_file_id
        ).toBe(root.file_id)
        expect((await processGroupDirtyPage(f.deps, f.vault, 1)).processed).toBe(0)
      } finally {
        await f.close()
      }
    })
    it('records intermediate membership removal/re-entry and leaves personal commits landed after an injected parser failure', async () => {
      const f = await scopedFixture(dialect)
      try {
        await f.t.db
          .updateTable('scope_grants')
          .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
          .where('id', '=', f.grant.id)
          .execute()
        const withGroups = '---\ngroups: ["[[Root]]"]\n---\nbody'
        await putBlob(f.t.app, f.device.deviceToken, withGroups)
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Member.md', withGroups)])
        ).results[0]
        await putBlob(f.t.app, f.device.deviceToken, 'body')
        const removed = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: first.version_id,
              sha: shaOf('body'),
              size: 4,
              mtime: 2,
            },
          ])
        ).results[0]
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: first.file_id,
            base_version_id: removed.version_id,
            sha: shaOf(withGroups),
            size: withGroups.length,
            mtime: 3,
          },
        ])
        await processGroupDirtyPage(f.deps, f.vault, 10)
        const facts = await f.t.db
          .selectFrom('scope_group_parse_facts')
          .select('facts')
          .where('file_id', '=', first.file_id)
          .orderBy('committed_seq')
          .execute()
        expect(facts.map((fact) => JSON.parse(fact.facts).active.length)).toEqual([1, 0, 1])
        await putBlob(f.t.app, f.device.deviceToken, 'next')
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Next.md', 'next')])
        await expect(
          processGroupDirtyPage(
            {
              ...f.deps,
              parseGroups: () => {
                throw new Error('parser fault')
              },
            },
            f.vault,
            10
          )
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(4)
      } finally {
        await f.close()
      }
    })
    it('holds certification on missing/pruned evidence while leaving already committed personal versions intact', async () => {
      const f = await scopedFixture(dialect)
      try {
        await f.t.db
          .updateTable('scope_grants')
          .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
          .where('id', '=', f.grant.id)
          .execute()
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Member.md', 'note')])
        await f.t.db.deleteFrom('scope_group_dirty').execute()
        await expect(processGroupDirtyPage(f.deps, f.vault, 10)).rejects.toMatchObject({
          code: 'scope_unavailable',
        })
        expect(
          (
            await f.t.db
              .selectFrom('scope_group_progress')
              .select('status')
              .executeTakeFirstOrThrow()
          ).status
        ).toBe('unavailable')
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
      } finally {
        await f.close()
      }
    })
  })
