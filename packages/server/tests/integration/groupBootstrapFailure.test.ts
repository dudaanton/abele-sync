import { describe, expect, it, vi } from 'vitest'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { prepareGroupBootstrap, rebuildGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'

async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  for (const text of ['root', 'second', 'third']) await putBlob(f.t.app, f.device.deviceToken, text)
  const root = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [
      create('Root.md', 'root'),
      create('Second.md', 'second'),
      create('Third.md', 'third'),
    ])
  ).results[0]
  const grant = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
    label: 'Root',
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'reader',
  })
  const progress = () =>
    f.t.db
      .selectFrom('scope_group_progress')
      .selectAll()
      .where('vault_id', '=', f.vault)
      .executeTakeFirst()
  const capture = (limit = 1000) =>
    prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, limit)
  const materialized = async () => ({
    facts: await f.t.db
      .selectFrom('scope_group_parse_facts')
      .selectAll()
      .orderBy('file_id')
      .execute(),
    pins: await f.t.db.selectFrom('scope_group_pins').selectAll().orderBy('file_id').execute(),
    leases: await f.t.db.selectFrom('scope_group_leases').selectAll().orderBy('id').execute(),
  })
  return { ...f, root, group: grant, progress, capture, materialized }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `bootstrap terminal evidence (${dialect})`,
    () => {
      for (const cursor of ['{', 'null', '{}'])
        it(`persists malformed bootstrap cursor evidence (${cursor})`, async () => {
          const f = await fixture(dialect)
          try {
            await f.capture(1)
            await f.t.db
              .updateTable('scope_group_progress')
              .set({ bootstrap_cursor: cursor })
              .where('vault_id', '=', f.vault)
              .execute()
            const before = await f.materialized()
            await expect(f.capture()).rejects.toMatchObject({ code: 'scope_unavailable' })
            expect(await f.progress()).toMatchObject({ status: 'unavailable' })
            expect(await f.materialized()).toEqual(before)
          } finally {
            await f.close()
          }
        })

      for (const page of ['first', 'later']) {
        for (const damage of ['missing blob', 'invalid facts'])
          it(`persists terminal ${damage} on the ${page} page without retaining partial capture`, async () => {
            const f = await fixture(dialect)
            try {
              if (page === 'later') expect((await f.capture(1)).phase).toBe('capture')
              const version = await f.t.db
                .selectFrom('versions')
                .selectAll()
                .where('vault_id', '=', f.vault)
                .$if(page === 'first', (q) => q.where('id', '=', f.root.version_id))
                .orderBy('file_id', 'desc')
                .executeTakeFirstOrThrow()
              if (damage === 'missing blob') await f.t.store.delete(version.blob_sha!)
              else
                await f.t.db
                  .insertInto('scope_group_parse_facts')
                  .values({
                    vault_id: f.vault,
                    file_id: version.file_id,
                    version_id: version.id,
                    status: 'valid',
                    facts: '{}',
                    committed_seq: version.seq,
                    recorded_at: f.deps.now().toISOString(),
                  })
                  .execute()
              const before = await f.materialized()
              // An unauthenticated request must not acquire a terminal-state write.
              await expect(
                prepareGroupBootstrap(f.deps, f.device.deviceToken, f.vault)
              ).rejects.toMatchObject({ code: 'unauthorized' })
              for (let retry = 0; retry < 2; retry++) {
                await expect(f.capture()).rejects.toMatchObject({ code: 'scope_unavailable' })
                expect(await f.progress()).toMatchObject({
                  status: 'unavailable',
                  generation: 0,
                  processed_seq: 3,
                })
                expect(await f.materialized()).toEqual(before)
                await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
                  code: 'scope_unavailable',
                })
              }
              await putBlob(f.t.app, f.device.deviceToken, 'later save')
              const later = (
                await commit(f.t.app, f.device.deviceToken, f.vault, [
                  create('Later.md', 'later save'),
                ])
              ).results[0]
              expect(
                await f.t.db
                  .selectFrom('scope_group_dirty')
                  .select('version_id')
                  .where('version_id', '=', later.version_id)
                  .execute()
              ).toEqual([])
              expect(await f.materialized()).toEqual(before)
              expect(
                await f.t.db
                  .selectFrom('scope_grants')
                  .select('state')
                  .where('id', '=', f.group.id)
                  .executeTakeFirstOrThrow()
              ).toEqual({ state: 'preparing' })
              if (damage === 'missing blob') {
                // Repair test storage, then explicitly rebuild; no automatic lease renewal.
                const text =
                  version.path === 'Root.md'
                    ? 'root'
                    : version.path === 'Second.md'
                      ? 'second'
                      : 'third'
                await f.t.store.put(Buffer.from(text), version.blob_sha!)
                await rebuildGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 0)
                await f.capture()
                expect((await processGroupDirtyPage(f.deps, f.vault)).ready).toBe(true)
              }
            } finally {
              await f.close()
            }
          })
        it(`rolls back a transient read failure on the ${page} page and permits retry`, async () => {
          const f = await fixture(dialect)
          try {
            if (page === 'later') await f.capture(1)
            const before = await f.materialized(),
              progress = await f.progress()
            const get = f.t.store.get.bind(f.t.store)
            let reads = 0
            const io = Object.assign(new Error('temporary disk failure'), { code: 'EIO' })
            const mock = vi.spyOn(f.t.store, 'get').mockImplementation(async (sha) => {
              if (++reads === 2) throw io
              return get(sha)
            })
            try {
              await expect(f.capture()).rejects.toBe(io)
            } finally {
              mock.mockRestore()
            }
            expect(await f.progress()).toEqual(progress)
            expect(await f.materialized()).toEqual(before)
            await f.capture()
            expect((await processGroupDirtyPage(f.deps, f.vault)).ready).toBe(true)
          } finally {
            await f.close()
          }
        })
      }
    }
  )
