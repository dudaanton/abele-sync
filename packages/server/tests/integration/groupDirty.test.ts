import { describe, expect, it, vi } from 'vitest'
import { commit as personalCommit } from '../../src/oplog/commit.js'
import type { KyselyPlugin } from 'kysely'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `ordered group dirty evidence (${dialect})`,
    () => {
      it('appends every intermediate version for active groups without parsing on the personal commit path', async () => {
        const f = await scopedFixture(dialect)
        try {
          // Synthetic group authority on this disposable fixture; public management stays fenced.
          await f.t.db
            .updateTable('scope_grants')
            .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
            .where('id', '=', f.grant.id)
            .execute()
          await putBlob(f.t.app, f.device.deviceToken, '---\ngroups: ["[[Root]]"]\n---\nbody')
          const first = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Member.md', '---\ngroups: ["[[Root]]"]\n---\nbody'),
            ])
          ).results[0]
          const away = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'move',
                file_id: first.file_id,
                base_version_id: first.version_id,
                to_path: 'Private/member.md',
              },
            ])
          ).results[0]
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: first.file_id,
              base_version_id: away.version_id,
              to_path: 'Member.md',
            },
          ])
          const dirty = await f.t.db
            .selectFrom('scope_group_dirty')
            .selectAll()
            .orderBy('committed_seq')
            .execute()
          expect(dirty).toHaveLength(3)
          expect(dirty.map((row) => row.operation)).toEqual(['create', 'move', 'move'])
          expect(await f.t.db.selectFrom('scope_group_parse_facts').selectAll().execute()).toEqual(
            []
          )
          expect(
            await f.t.db.selectFrom('scope_group_pins').select('version_id').execute()
          ).not.toHaveLength(0)
        } finally {
          await f.close()
        }
      })
      it('rolls the personal commit back if durable group evidence cannot be stored', async () => {
        const f = await scopedFixture(dialect)
        try {
          await f.t.db
            .updateTable('scope_grants')
            .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
            .where('id', '=', f.grant.id)
            .execute()
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const fault: KyselyPlugin = {
            transformQuery(args) {
              if (
                args.node.kind === 'InsertQueryNode' &&
                JSON.stringify(args.node).includes('scope_group_dirty')
              )
                throw new Error('dirty evidence fault')
              return args.node
            },
            async transformResult(args) {
              return args.result
            },
          }
          await expect(
            personalCommit(
              { ...f.deps, db: f.t.db.withPlugin(fault) },
              f.vault,
              { kind: 'device', id: f.device.deviceId, name: 'Fixture' },
              [create('Member.md', 'note')]
            )
          ).rejects.toThrow('dirty evidence fault')
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual([])
          expect(await f.t.db.selectFrom('files').select('id').execute()).toEqual([])
        } finally {
          await f.close()
        }
      })
      it('adds no group SQL/parser/dirty processing for folder-only or no-grant personal versions', async () => {
        const f = await scopedFixture(dialect)
        try {
          const selected: string[] = []
          const plugin: KyselyPlugin = {
            transformQuery(args) {
              selected.push(JSON.stringify(args.node))
              return args.node
            },
            async transformResult(args) {
              return args.result
            },
          }
          await putBlob(
            f.t.app,
            f.device.deviceToken,
            '---\ngroups: broken\n---\n[[private body link]]'
          )
          await personalCommit(
            { ...f.deps, db: f.t.db.withPlugin(plugin) },
            f.vault,
            { kind: 'device', id: f.device.deviceId, name: 'Fixture' },
            [create('Agents/a.md', '---\ngroups: broken\n---\n[[private body link]]')]
          )
          expect(selected.filter((query) => /scope_group/.test(query))).toEqual([])
          expect(selected.length).toBeGreaterThan(0)
          await f.t.db
            .updateTable('scope_grants')
            .set({ revoked_at: f.deps.now().toISOString() })
            .where('id', '=', f.grant.id)
            .execute()
          selected.length = 0
          await personalCommit(
            { ...f.deps, db: f.t.db.withPlugin(plugin) },
            f.vault,
            { kind: 'device', id: f.device.deviceId, name: 'Fixture' },
            [create('Other.md', '---\ngroups: broken\n---\n[[private body link]]')]
          )
          expect(selected.filter((query) => /scope_group/.test(query))).toEqual([])
          expect(await f.t.db.selectFrom('scope_group_dirty').selectAll().execute()).toEqual([])
        } finally {
          vi.restoreAllMocks()
          await f.close()
        }
      })
    }
  )
