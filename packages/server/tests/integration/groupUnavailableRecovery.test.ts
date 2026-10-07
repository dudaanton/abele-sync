import { describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { createGroupGrant, updateGroupGrant } from '../../src/auth/groupManagement.js'
import { issueFolderKey } from '../../src/auth/folderManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'
import { requireFolderVersion } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
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
  const revokeGroup = (id: string) =>
    updateGroupGrant(f.deps, f.owner.accountToken, f.vault, id, {
      expected_revision: 0,
      revoke: true,
    })
  return { ...f, root, add, prepare, first, progress, save, revokeGroup }
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
            else await f.revokeGroup(f.first.id)
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
          await f.revokeGroup(f.first.id)
          await expect(f.prepare()).rejects.toMatchObject({ code: 'scope_unavailable' })
          await f.revokeGroup(second.id)
          await f.add()
          expect((await f.prepare()).ready).toBe(true)
        } finally {
          await f.close()
        }
      })

      it('recovers through owner revoke/create/prepare HTTP actions without a database repair', async () => {
        const f = await fixture(dialect)
        try {
          await f.save('Gap.md', 'gap')
          await f.t.db.deleteFrom('scope_group_dirty').where('vault_id', '=', f.vault).execute()
          await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
            code: 'scope_unavailable',
          })
          const live = await liveScopedServer(f)
          try {
            const base = `${live.base}/v1/vaults/${f.vault}/grants/groups`
            const send = async (
              path: string,
              input: unknown,
              method = 'POST',
              token = f.owner.accountToken
            ) => {
              const response = await fetch(base + path, {
                method,
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(input),
              })
              return { status: response.status, body: await response.json() }
            }
            const input = {
              label: 'Replacement',
              root_file_id: f.root.file_id,
              expected_root_version: f.root.version_id,
              role: 'reader',
            }
            const blocked = await send('', input)
            expect(blocked).toMatchObject({
              status: 200,
              body: {
                state: 'preparing',
                preparation: { ok: false, error: { code: 'scope_unavailable' } },
              },
            })
            for (const id of [f.first.id, blocked.body.id])
              expect(
                (await send(`/${id}`, { expected_revision: 0, revoke: true }, 'PATCH')).status
              ).toBe(200)
            await f.save('Idle.md', body('committed while retired'))
            const before = await f.progress()
            expect((await send('', input, 'POST', f.device.deviceToken)).status).toBe(401)
            expect(await f.progress()).toEqual(before)
            expect(await send('', input)).toMatchObject({
              status: 200,
              body: { state: 'active', preparation: { ok: true, state: 'active' } },
            })
            expect(await send('/prepare', {})).toMatchObject({ status: 200, body: { ready: true } })
          } finally {
            await live.close()
          }
        } finally {
          await f.close()
        }
      })

      for (const lineage of ['{', 'null', '{"version":null}', 'nonboolean-complete'])
        it(`keeps malformed durable lineage unavailable (${lineage})`, async () => {
          const f = await fixture(dialect)
          try {
            await f.save('Member.md', body('pending'))
            const row = await f.t.db
              .selectFrom('scope_group_dirty')
              .selectAll()
              .where('vault_id', '=', f.vault)
              .executeTakeFirstOrThrow()
            const corrupted =
              lineage === 'nonboolean-complete'
                ? JSON.stringify({ ...JSON.parse(row.lineage), complete: 'true' })
                : lineage
            await f.t.db
              .updateTable('scope_group_dirty')
              .set({ lineage: corrupted })
              .where('vault_id', '=', f.vault)
              .execute()
            await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
              code: 'scope_unavailable',
            })
            expect((await f.progress()).status).toBe('unavailable')
          } finally {
            await f.close()
          }
        })

      for (const damage of [
        'missing blob',
        'truncated envelope',
        'bad authentication tag',
        'source JSON syntax',
        'source JSON shape',
        'merge JSON syntax',
        'cached fact JSON syntax',
      ])
        it(`marks confirmed evidence loss unavailable immediately (${damage})`, async () => {
          const f = await fixture(dialect)
          try {
            const text = body('pending evidence')
            const note = await f.save('Member.md', text)
            const before = await f.progress()
            const sha = shaOf(text)
            if (damage === 'missing blob') await f.t.store.delete(sha)
            else if (damage === 'truncated envelope')
              await writeFile(f.t.store.pathFor(sha), 'broken')
            else if (damage === 'bad authentication tag') {
              const envelope = await readFile(f.t.store.pathFor(sha))
              envelope[envelope.length - 1] = envelope[envelope.length - 1]! ^ 1
              await writeFile(f.t.store.pathFor(sha), envelope)
            } else if (damage === 'merge JSON syntax')
              await f.t.db
                .updateTable('versions')
                .set({ merge: '{' })
                .where('id', '=', note.version_id)
                .execute()
            else if (damage === 'cached fact JSON syntax') {
              const version = await f.t.db
                .selectFrom('versions')
                .select('seq')
                .where('id', '=', note.version_id)
                .executeTakeFirstOrThrow()
              await f.t.db
                .insertInto('scope_group_parse_facts')
                .values({
                  vault_id: f.vault,
                  file_id: note.file_id,
                  version_id: note.version_id,
                  status: 'valid',
                  facts: '{',
                  committed_seq: version.seq,
                  recorded_at: f.deps.now().toISOString(),
                })
                .execute()
            } else
              await f.t.db
                .updateTable('version_security_sources')
                .set({ source_version_ids: damage === 'source JSON syntax' ? '{' : '{}' })
                .where('version_id', '=', note.version_id)
                .execute()
            for (let retry = 0; retry < 2; retry++) {
              const error = await processGroupDirtyPage(f.deps, f.vault).catch(
                (error: unknown) => error
              )
              expect(error).toMatchObject({ code: 'scope_unavailable', details: {} })
              expect(error).not.toMatchObject({ details: { retryable: true } })
              expect(await f.progress()).toMatchObject({
                status: 'unavailable',
                processed_seq: before.processed_seq,
              })
            }
            const later = await f.save('Later.md', body('later'))
            expect(
              await f.t.db
                .selectFrom('scope_group_dirty')
                .select('version_id')
                .where('version_id', '=', later.version_id)
                .execute()
            ).toEqual([])
          } finally {
            await f.close()
          }
        })

      for (const code of ['EIO', 'SQLITE_BUSY', '40P01'])
        it(`retries an operational failure (${code}) without losing subsequent committed evidence`, async () => {
          const f = await fixture(dialect)
          try {
            const key = await issueFolderKey(f.deps, f.owner.accountToken, f.vault, f.first.id, {
              attempt_id: 'retry-reader',
              name: 'retry-reader',
              role: 'reader',
              expires_at: '2030-01-02T00:00:00.000Z',
            })
            const note = await f.save('Member.md', body('pending'))
            const before = await f.progress()
            const error = Object.assign(new Error('temporary infrastructure failure'), { code })
            const interrupted =
              code === 'EIO'
                ? vi.spyOn(f.deps.store, 'get').mockRejectedValueOnce(error)
                : vi.spyOn(f.deps.db, 'transaction').mockImplementationOnce(() => {
                    throw error
                  })
            try {
              await expect(processGroupDirtyPage(f.deps, f.vault)).rejects.toMatchObject({
                code: 'scope_unavailable',
                details: { retryable: true },
                cause: { code },
              })
            } finally {
              interrupted.mockRestore()
            }
            expect(await f.progress()).toEqual(before)
            await expect(
              requireFolderVersion(
                f.deps,
                key.key_token,
                f.vault,
                f.first.id,
                note.file_id,
                note.version_id
              )
            ).rejects.toMatchObject({ code: 'scope_updating' })
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
