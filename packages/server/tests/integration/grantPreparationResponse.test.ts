import { describe, expect, it } from 'vitest'
import { login } from '../../src/auth/accounts.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { TEST_PASSWORD } from '../helpers/testApp.js'
import { commit, create, putBlob } from '../helpers/ops.js'

async function freshSession(f: Awaited<ReturnType<typeof scopedFixture>>) {
  f.setClock('2030-01-01T00:06:00.000Z')
  const owner = await f.t.db
    .selectFrom('accounts')
    .select('email')
    .where('id', '=', f.owner.accountId)
    .executeTakeFirstOrThrow()
  return (await login(f.deps, owner.email, TEST_PASSWORD)).account_token
}
function request(base: string, token: string) {
  return async (path: string, body: unknown, method = 'POST') => {
    const response = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `committed grant preparation response (${dialect})`,
    () => {
      it('returns the created group ID and PATCH revision when a shared preparation lease has expired', async () => {
        const f = await scopedFixture(dialect),
          live = await liveScopedServer(f)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'root')
          const roots = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Project/Root.md', 'root'),
              create('Project/Other.md', 'root'),
            ])
          ).results
          const input = {
            label: 'First',
            root_file_id: roots[0]!.file_id,
            expected_root_version: roots[0]!.version_id,
            role: 'editor',
          }
          await createGroupGrant(f.deps, f.owner.accountToken, f.vault, input)
          expect(
            (await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault, 1)).phase
          ).toBe('capture')
          const session = await freshSession(f),
            send = request(live.base, session)
          const base = `/v1/vaults/${f.vault}/grants/groups`
          const created = await send(base, { ...input, label: 'Second' })
          expect(created.status).toBe(200)
          expect(created.body).toMatchObject({
            id: expect.any(String),
            label: 'Second',
            state: 'preparing',
            acl_revision: 0,
            preparation: { ok: false, error: { code: 'scope_unavailable' } },
          })
          const id = created.body.id
          expect(
            await send(`${base}/${id}`, { expected_revision: 0, label: 'Renamed' }, 'PATCH')
          ).toMatchObject({
            status: 200,
            body: {
              id,
              label: 'Renamed',
              acl_revision: 1,
              preparation: { ok: false, error: { code: 'scope_unavailable' } },
            },
          })
          // Retry only preparation, not creation or the committed PATCH. These retries
          // cannot consume grant slots or advance the mutation's revision again.
          for (let n = 0; n < 3; n++) expect((await send(`${base}/prepare`, {})).status).toBe(503)
          expect(
            (await send(`${base}/${id}`, { expected_revision: 0, label: 'Renamed' }, 'PATCH'))
              .status
          ).toBe(409)
          expect(
            await f.t.db
              .selectFrom('scope_grants')
              .select('id')
              .where('selector_kind', '=', 'group')
              .execute()
          ).toHaveLength(2)
          expect(
            await f.t.db
              .selectFrom('scope_grants')
              .select(['label', 'acl_revision'])
              .where('id', '=', id)
              .executeTakeFirstOrThrow()
          ).toEqual({ label: 'Renamed', acl_revision: 1 })
        } finally {
          await live.close()
          await f.close()
        }
      })
      it('keeps folder create and PATCH identities visible when their preparation fails', async () => {
        const f = await scopedFixture(dialect),
          live = await liveScopedServer(f)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const files = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/a.md', 'note'),
              create('Agents/b.md', 'note'),
            ])
          ).results
          expect(
            (
              await prepareFolderAdmissions(
                { ...f.deps, folderPreparationPageSize: 1 },
                f.owner.accountToken,
                f.vault,
                f.grant.id
              )
            ).state
          ).toBe('preparing')
          const send = request(live.base, await freshSession(f)),
            base = `/v1/vaults/${f.vault}/grants`
          expect(
            await send(
              `${base}/${f.grant.id}`,
              { expected_revision: 0, label: 'Saved label' },
              'PATCH'
            )
          ).toMatchObject({
            status: 200,
            body: {
              id: f.grant.id,
              label: 'Saved label',
              acl_revision: 1,
              preparation: { ok: false, error: { code: 'scope_unavailable' } },
            },
          })
          // A missing exact starting-head proof makes the newly created folder's
          // preparation fail, but must not hide its already-committed identity.
          await f.t.db.deleteFrom('versions').where('id', '=', files[0]!.version_id).execute()
          const created = await send(base, { label: 'New folder', prefix: 'Team/', role: 'editor' })
          expect(created.status).toBe(201)
          expect(created.body).toMatchObject({
            id: expect.any(String),
            state: 'preparing',
            preparation: { ok: false, error: { code: 'scope_unavailable' } },
          })
          for (let n = 0; n < 3; n++)
            expect((await send(`${base}/${created.body.id}/prepare`, {})).status).toBe(503)
          expect(
            await f.t.db
              .selectFrom('scope_grants')
              .select('id')
              .where('selector_kind', '=', 'folder')
              .execute()
          ).toHaveLength(2)
        } finally {
          await live.close()
          await f.close()
        }
      })
    }
  )
