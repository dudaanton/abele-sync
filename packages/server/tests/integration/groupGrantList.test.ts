import { describe, expect, it } from 'vitest'
import { createGroupGrant, updateGroupGrant } from '../../src/auth/groupManagement.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'

type Fixture = Awaited<ReturnType<typeof scopedFixture>>
async function group(f: Fixture, label: string, expires_at: string | null = null, vault = f.vault) {
  const device = vault === f.vault ? f.device : await f.t.device(f.owner.accountToken, vault)
  await putBlob(f.t.app, device.deviceToken, 'root')
  const root = (
    await commit(f.t.app, device.deviceToken, vault, [create(`Project/${label}.md`, 'root')])
  ).results[0]!
  return createGroupGrant(f.deps, f.owner.accountToken, vault, {
    label,
    root_file_id: root.file_id,
    expected_root_version: root.version_id,
    role: 'editor',
    expires_at,
  })
}
function request(base: string) {
  return async (path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    }
  }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`owner group grant list (${dialect})`, () => {
    it('returns only safe stored fields and the current revision usable for revocation', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const grant = await group(f, 'Original', '2030-01-02T00:00:00.000Z'),
          send = request(live.base),
          base = `/v1/vaults/${f.vault}/grants/groups`
        const updated = await send(`${base}/${grant.id}`, f.owner.accountToken, {
          expected_revision: grant.acl_revision,
          label: 'Renamed',
          role: 'reader',
        })
        expect(updated.status).toBe(200)
        const listed = await send(base, f.owner.accountToken)
        expect(listed.status).toBe(200)
        expect(listed.cacheControl).toBe('no-store')
        expect(listed.body).toEqual([
          {
            id: grant.id,
            vault_id: f.vault,
            label: 'Renamed',
            selector_kind: 'group',
            folder_prefix: null,
            root_file_id: grant.root_file_id,
            role: 'reader',
            state: 'active',
            acl_revision: 1,
            scope_revision: 1,
            publication_revision: 0,
            created_at: '2030-01-01T00:00:00.000Z',
            expires_at: '2030-01-02T00:00:00.000Z',
            revoked_at: null,
          },
        ])
        expect(
          (
            await send(`${base}/${grant.id}`, f.owner.accountToken, {
              expected_revision: grant.acl_revision,
              revoke: true,
            })
          ).status
        ).toBe(409)
        const revoked = await send(`${base}/${grant.id}`, f.owner.accountToken, {
          expected_revision: listed.body[0].acl_revision,
          revoke: true,
        })
        expect(revoked.status).toBe(200)
        expect(revoked.body).toMatchObject({
          id: grant.id,
          state: 'unavailable',
          revoked_at: '2030-01-01T00:00:00.000Z',
          acl_revision: 2,
        })
        expect((await send(base, f.owner.accountToken)).body).toEqual([revoked.body])
      } finally {
        await live.close()
        await f.close()
      }
    })
    it('refuses non-owners and non-account credentials exactly like the folder list', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const outsider = await f.t.account(),
          send = request(live.base),
          base = `/v1/vaults/${f.vault}/grants`
        for (const [token, status, code] of [
          [undefined, 401, 'unauthorized'],
          [f.device.deviceToken, 401, 'unauthorized'],
          [f.a.key_token, 401, 'unauthorized'],
          [outsider.accountToken, 403, 'forbidden'],
        ] as const) {
          const folder = await send(base, token),
            groups = await send(`${base}/groups`, token)
          expect(folder.status).toBe(status)
          expect(groups.status).toBe(status)
          expect(groups.body.error.code).toBe(code)
          expect(groups.cacheControl).toBe('no-store')
        }
        f.setClock('2030-01-01T00:05:00.000Z')
        expect((await send(base, f.owner.accountToken)).status).toBe(401)
        expect((await send(`${base}/groups`, f.owner.accountToken)).status).toBe(401)
      } finally {
        await live.close()
        await f.close()
      }
    })
    it('isolates vaults even when they have the same owner and excludes folder grants', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const other = (await f.t.vault(f.owner.accountToken, 'Other')).vaultId,
          ownGroup = await group(f, 'Own'),
          otherGroup = await group(f, 'Other', null, other),
          send = request(live.base)
        for (const [vault, expected] of [
          [f.vault, ownGroup],
          [other, otherGroup],
        ] as const) {
          const listed = await send(`/v1/vaults/${vault}/grants/groups`, f.owner.accountToken)
          expect(listed.status).toBe(200)
          expect(listed.body).toEqual([expected])
        }
        const empty = (await f.t.vault(f.owner.accountToken, 'Empty')).vaultId
        expect(
          (await send(`/v1/vaults/${empty}/grants/groups`, f.owner.accountToken)).body
        ).toEqual([])
      } finally {
        await live.close()
        await f.close()
      }
    })
    it('includes preparing, unavailable, revoked and expired grants with live grants first', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const expired = await group(f, 'Expired', '2030-01-01T00:00:01.000Z'),
          retired = await group(f, 'Retired')
        const revoked = await updateGroupGrant(f.deps, f.owner.accountToken, f.vault, retired.id, {
          expected_revision: retired.acl_revision,
          revoke: true,
        })
        f.setClock('2030-01-01T00:00:02.000Z')
        const preparing = await group(f, 'Preparing'),
          unavailable = await group(f, 'Unavailable')
        await f.t.db
          .updateTable('scope_grants')
          .set({ state: 'unavailable' })
          .where('id', '=', unavailable.id)
          .execute()
        const listed = await request(live.base)(
          `/v1/vaults/${f.vault}/grants/groups`,
          f.owner.accountToken
        )
        expect(listed.status).toBe(200)
        const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
        expect(listed.body).toEqual([
          ...[preparing, { ...unavailable, state: 'unavailable' }].sort(byId),
          ...[expired, revoked].sort(byId),
        ])
      } finally {
        await live.close()
        await f.close()
      }
    })
    it('mirrors the folder list ceiling without retired grants hiding a live group', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const grant = await group(f, 'Live'),
          stored = await f.t.db
            .selectFrom('scope_grants')
            .selectAll()
            .where('id', '=', grant.id)
            .executeTakeFirstOrThrow()
        await f.t.db
          .insertInto('scope_grants')
          .values(
            Array.from({ length: 65 }, (_, i) => ({
              ...stored,
              id: `retired-${String(i).padStart(2, '0')}`,
              created_at: '2029-12-31T00:00:00.000Z',
              revoked_at: '2030-01-01T00:00:00.000Z',
              state: 'unavailable' as const,
            }))
          )
          .execute()
        const listed = await request(live.base)(
          `/v1/vaults/${f.vault}/grants/groups`,
          f.owner.accountToken
        )
        expect(listed.status).toBe(200)
        expect(listed.body).toHaveLength(64)
        expect(listed.body[0]).toEqual(grant)
        expect(listed.body.slice(1).map((row: { id: string }) => row.id)).toEqual(
          Array.from({ length: 63 }, (_, i) => `retired-${String(i).padStart(2, '0')}`)
        )
      } finally {
        await live.close()
        await f.close()
      }
    })
  })
