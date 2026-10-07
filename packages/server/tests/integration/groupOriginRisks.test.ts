import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { api } from '../helpers/client.js'
import { commit as personalCommit } from '../../src/oplog/commit.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await f.t.db
    .updateTable('scope_grants')
    .set({ selector_kind: 'group', folder_prefix: null, root_file_id: 'root' })
    .where('id', '=', f.grant.id)
    .execute()
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')]))
    .results[0]
  await f.t.db
    .updateTable('scope_grants')
    .set({ root_file_id: root.file_id })
    .where('id', '=', f.grant.id)
    .execute()
  const recipient = async (ops: any[]) => {
    const result = await personalCommit(
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
      ops
    )
    const first = result.results[0]!
    if (first.status === 'rejected') throw new Error('recipient fixture rejected')
    return first
  }
  const facts = async (version: string) =>
    JSON.parse(
      (
        await f.t.db
          .selectFrom('scope_group_parse_facts')
          .select('facts')
          .where('version_id', '=', version)
          .executeTakeFirstOrThrow()
      ).facts
    )
  return { ...f, root, recipient, facts }
}
const grouped = (token = 'Root', body = 'body') => `---\ngroups: ["[[${token}]]"]\n---\n${body}`
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `group origin laundering risks (${dialect})`,
    () => {
      it('preserves recipient origin when the owner automatically rewrites a renamed bound target', async () => {
        const f = await fixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, grouped())
          const member = await f.recipient([create('Member.md', grouped())])
          await processGroupDirtyPage(f.deps, f.vault, 100)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: f.root.file_id,
              base_version_id: f.root.version_id,
              to_path: 'Renamed.md',
            },
          ])
          await putBlob(f.t.app, f.device.deviceToken, grouped('Renamed'))
          const changed = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: member.file_id,
                base_version_id: member.version_id,
                sha: shaOf(grouped('Renamed')),
                size: grouped('Renamed').length,
                mtime: 2,
              },
            ])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault, 100)
          expect((await f.facts(changed.version_id)).memory['renamed.md'].origin.kind).toBe(
            'recipient'
          )
          expect((await f.facts(changed.version_id)).memory['renamed.md'].targetId).toBe(
            f.root.file_id
          )
        } finally {
          await f.close()
        }
      })
      it('does not treat note deletion and an owner stale-base body edit as intentional membership removal/addition', async () => {
        const f = await fixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, grouped())
          const member = await f.recipient([create('Member.md', grouped())])
          await processGroupDirtyPage(f.deps, f.vault, 100)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            { op: 'delete', file_id: member.file_id, base_version_id: member.version_id },
          ])
          await putBlob(f.t.app, f.device.deviceToken, grouped('Root', 'owner body'))
          const restored = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              {
                op: 'modify',
                file_id: member.file_id,
                base_version_id: member.version_id,
                sha: shaOf(grouped('Root', 'owner body')),
                size: grouped('Root', 'owner body').length,
                mtime: 3,
              },
            ])
          ).results[0]
          await processGroupDirtyPage(f.deps, f.vault, 100)
          expect((await f.facts(restored.version_id)).memory['root.md'].origin.kind).toBe(
            'recipient'
          )
        } finally {
          await f.close()
        }
      })
      for (const unresolved of [false, true])
        it(`copies ${unresolved ? 'unresolved' : 'bound'} lineage without resolving against a replacement/late identity`, async () => {
          const f = await fixture(dialect)
          try {
            const token = unresolved ? 'Late' : 'Root'
            await putBlob(f.t.app, f.device.deviceToken, grouped(token))
            const member = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                create('Member.md', grouped(token)),
              ])
            ).results[0]
            await processGroupDirtyPage(f.deps, f.vault, 100)
            if (!unresolved)
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                {
                  op: 'move',
                  file_id: f.root.file_id,
                  base_version_id: f.root.version_id,
                  to_path: 'Renamed.md',
                },
              ])
            await putBlob(f.t.app, f.device.deviceToken, 'replacement')
            const replacement = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                create(`${token}.md`, 'replacement'),
              ])
            ).results[0]
            await api(f.t.app, f.device.deviceToken).patch(`/v1/vaults/${f.vault}/settings`, {
              conflict: 'conflict-file',
            })
            for (const body of ['head', 'incoming']) {
              await putBlob(f.t.app, f.device.deviceToken, grouped(token, body))
              const result = (
                await commit(f.t.app, f.device.deviceToken, f.vault, [
                  {
                    op: 'modify',
                    file_id: member.file_id,
                    base_version_id: member.version_id,
                    sha: shaOf(grouped(token, body)),
                    size: grouped(token, body).length,
                    mtime: 2,
                  },
                ])
              ).results[0]
              if (body === 'incoming') {
                expect(result.status).toBe('conflict')
                await processGroupDirtyPage(f.deps, f.vault, 100)
                const binding = await f.t.db
                  .selectFrom('scope_group_bindings')
                  .selectAll()
                  .where('source_file_id', '=', result.conflict_file_id)
                  .executeTakeFirstOrThrow()
                expect(binding.target_file_id).toBe(unresolved ? null : f.root.file_id)
                expect(binding.target_file_id).not.toBe(replacement.file_id)
              }
            }
          } finally {
            await f.close()
          }
        })
      it('holds an over-budget note locally while unrelated groups and subsequent corrections still advance', async () => {
        const f = await fixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, grouped('Root', 'safe'))
          const safe = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Safe.md', grouped('Root', 'safe')),
            ])
          ).results[0]
          let source: any
          for (let pass = 0; pass < 4; pass++) {
            const text = `---\ngroups: ${JSON.stringify(Array.from({ length: 256 }, (_, i) => `[[Unresolved-${pass}-${i}]]`))}\n---\nbody`
            await putBlob(f.t.app, f.device.deviceToken, text)
            source = await f.recipient([
              source
                ? {
                    op: 'modify',
                    file_id: source.file_id,
                    base_version_id: source.version_id,
                    sha: shaOf(text),
                    size: text.length,
                    mtime: pass + 1,
                  }
                : create('Budget.md', text),
            ])
          }
          expect((await processGroupDirtyPage(f.deps, f.vault, 100)).ready).toBe(true)
          expect((await f.facts(source.version_id)).active).toEqual([])
          expect((await f.facts(source.version_id)).limited).toBe(true)
          await putBlob(f.t.app, f.device.deviceToken, grouped('Root', 'safe later'))
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: safe.file_id,
              base_version_id: safe.version_id,
              sha: shaOf(grouped('Root', 'safe later')),
              size: grouped('Root', 'safe later').length,
              mtime: 5,
            },
          ])
          expect((await processGroupDirtyPage(f.deps, f.vault, 100)).processed).toBe(1)
        } finally {
          await f.close()
        }
      })
    }
  )
