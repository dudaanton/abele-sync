import { describe, expect, it, vi } from 'vitest'
import { createGroupGrant, updateGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { requireFolderVersion } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

const body = (text: string) => `---\ngroups: ["[[Root]]"]\n---\n${text}`
async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'root')
  const root = (await commit(f.t.app, f.device.deviceToken, f.vault, [create('Root.md', 'root')]))
    .results[0]
  const add = () =>
    createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
      label: 'Root',
      root_file_id: root.file_id,
      expected_root_version: root.version_id,
      role: 'reader',
    })
  const prepare = async () => {
    await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
    return processGroupDirtyPage(f.deps, f.vault)
  }
  const first = await add()
  await prepare()
  const progress = () =>
    f.t.db
      .selectFrom('scope_group_progress')
      .selectAll()
      .where('vault_id', '=', f.vault)
      .executeTakeFirstOrThrow()
  const save = async (path: string, text: string) => {
    await putBlob(f.t.app, f.device.deviceToken, text)
    return (await commit(f.t.app, f.device.deviceToken, f.vault, [create(path, text)])).results[0]
  }
  const revoke = (id: string) =>
    updateGroupGrant(f.deps, f.owner.accountToken, f.vault, id, {
      expected_revision: 0,
      revoke: true,
    })
  return { ...f, add, prepare, first, progress, save, revoke }
}

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `group unavailable recovery (${dialect})`,
    () => {
      for (const state of ['ready', 'unavailable', 'expired', 'renewed'] as const)
        it(`starts a proven current baseline after the last group retires (${state})`, async () => {
          const f = await fixture(dialect)
          try {
            const old = await f.save('Member.md', body('old audience'))
            await processGroupDirtyPage(f.deps, f.vault)
            if (state === 'unavailable') {
              await f.save('Gap.md', 'gap')
              await f.t.db.deleteFrom('scope_group_dirty').where('vault_id', '=', f.vault).execute()
              await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
                code: 'scope_unavailable',
              })
              expect((await f.progress()).status).toBe('unavailable')
            }
            if (state === 'expired' || state === 'renewed')
              await f.t.db
                .updateTable('scope_grants')
                .set({ expires_at: '2029-12-31T23:59:59.000Z' })
                .where('id', '=', f.first.id)
                .execute()
            else await f.revoke(f.first.id)
            // Personal commits deliberately do not collect group evidence with no live audience.
            const before = await f.progress()
            const text = body('current audience')
            await putBlob(f.t.app, f.device.deviceToken, text)
            const current = (
              await commit(f.t.app, f.device.deviceToken, f.vault, [
                {
                  op: 'modify',
                  file_id: old.file_id,
                  base_version_id: old.version_id,
                  sha: shaOf(text),
                  size: Buffer.byteLength(text),
                  mtime: 2,
                },
              ])
            ).results[0]
            expect(
              await f.t.db
                .selectFrom('scope_group_dirty')
                .select('version_id')
                .where('version_id', '=', current.version_id)
                .execute()
            ).toEqual([])
            const next =
              state === 'renewed'
                ? await updateGroupGrant(f.deps, f.owner.accountToken, f.vault, f.first.id, {
                    expected_revision: 0,
                    expires_at: '2030-01-02T00:00:00.000Z',
                  })
                : await f.add()
            expect((await f.progress()).generation).toBe(before.generation + 1)
            expect((await f.progress()).status).toBe('preparing')
            expect(
              await f.t.db
                .selectFrom('scope_group_pins')
                .select('version_id')
                .where('vault_id', '=', f.vault)
                .execute()
            ).toEqual([])
            const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, next.id, {
              attempt_id: 'new-audience',
              name: 'new-audience',
              role: 'reader',
              expires_at: '2030-01-02T00:00:00.000Z',
            })
            await expect(
              requireFolderVersion(
                f.deps,
                key.key_token,
                f.vault,
                next.id,
                current.file_id,
                current.version_id
              )
            ).rejects.toBeDefined()
            expect((await f.prepare()).ready).toBe(true)
            await expect(
              requireFolderVersion(
                f.deps,
                key.key_token,
                f.vault,
                next.id,
                current.file_id,
                current.version_id
              )
            ).resolves.toBeDefined()
            await expect(
              requireFolderVersion(
                f.deps,
                key.key_token,
                f.vault,
                next.id,
                old.file_id,
                old.version_id
              )
            ).rejects.toMatchObject({ code: 'not_found' })
          } finally {
            await f.close()
          }
        })

      it('does not reset unavailable evidence or skip queued private gaps for a still-live audience', async () => {
        const f = await fixture(dialect)
        try {
          await f.save('Gap.md', 'gap')
          await f.t.db.deleteFrom('scope_group_dirty').where('vault_id', '=', f.vault).execute()
          await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
            code: 'scope_unavailable',
          })
          const before = await f.progress()
          const second = await f.add()
          expect(await f.progress()).toEqual(before)
          await expect(f.prepare()).rejects.toMatchObject({ code: 'scope_unavailable' })
          await f.revoke(f.first.id)
          await expect(f.prepare()).rejects.toMatchObject({ code: 'scope_unavailable' })
          await f.revoke(second.id)
          await f.add()
          expect((await f.prepare()).ready).toBe(true)
        } finally {
          await f.close()
        }
      })

      for (const code of ['EIO', 'SQLITE_BUSY', '40P01'])
        it(`retries an operational failure (${code}) without losing subsequent committed evidence`, async () => {
          const f = await fixture(dialect)
          try {
            const note = await f.save('Member.md', body('pending'))
            const before = await f.progress()
            const read = vi
              .spyOn(f.deps.store, 'get')
              .mockRejectedValueOnce(Object.assign(new Error('temporary read failure'), { code }))
            try {
              await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
                code: 'scope_unavailable',
              })
            } finally {
              read.mockRestore()
            }
            expect(await f.progress()).toEqual(before)
            const later = await f.save('Later.md', body('later'))
            expect(
              await f.t.db
                .selectFrom('scope_group_dirty')
                .select('version_id')
                .where('version_id', 'in', [note.version_id, later.version_id])
                .execute()
            ).toHaveLength(2)
            expect(await processGroupDirtyPage(f.deps, f.vault)).toEqual({
              processed: 2,
              ready: true,
            })
            expect((await f.progress()).status).toBe('ready')
          } finally {
            await f.close()
          }
        })
    }
  )
