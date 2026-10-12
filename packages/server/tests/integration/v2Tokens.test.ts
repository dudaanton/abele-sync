import { afterEach, describe, expect, it } from 'vitest'
import {
  decodeAccessToken,
  V2ConnectionSchema,
  V2IssueTokenResponseSchema,
  V2TokensResponseSchema,
} from '@abele/sync-protocol'
import { createUser } from '../../src/access/tokens.js'
import { v2Server, type V2Server } from '../helpers/v2Server.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`v2 token authority (${dialect})`, () => {
    let server: V2Server | undefined
    afterEach(async () => {
      await server?.close()
      server = undefined
    })
    const setup = async () => {
      server = await v2Server(dialect)
      const deps = { db: server.db, pepper: server.config.tokenPepper }
      const root = await createUser(deps, 'Owner', server.address)
      const key = decodeAccessToken(root.token).key
      const request = async (key: string, path: string, method = 'GET', body?: unknown) => {
        const response = await fetch(server!.address + path, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            // This test measures durable authority, not a client's retry of stale keepalive sockets.
            connection: 'close',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        return { status: response.status, body: await response.json() }
      }
      const issue = async (bearer: string, id = root.info.scope.id, kind = 'folder') => {
        const response = await request(bearer, '/v2/tokens', 'POST', {
          scope: { kind, id },
          label: 'Device',
        })
        expect(response.status).toBe(201)
        return V2IssueTokenResponseSchema.parse(response.body)
      }
      return { deps, root, key, request, issue }
    }
    it('001 creates exactly one space, stable root, and hashed 256-bit token atomically', async () => {
      const { root, key } = await setup()
      expect(await server!.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
      expect(await server!.db.selectFrom('spaces').selectAll().execute()).toHaveLength(1)
      expect(await server!.db.selectFrom('vault_seq').selectAll().execute()).toEqual([
        expect.objectContaining({ head_seq: 0 }),
      ])
      const stored = await server!.db
        .selectFrom('access_tokens')
        .selectAll()
        .executeTakeFirstOrThrow()
      expect(stored.secret_hash).not.toContain(key)
      expect(stored.secret_hash).toMatch(/^[a-f0-9]{64}$/)
      const directory = await server!.db
        .selectFrom('directories')
        .selectAll()
        .executeTakeFirstOrThrow()
      expect(directory.id).toBe(root.info.scope.id)
      expect(directory.path).toBe('/')
      await expect(
        server!.db
          .insertInto('spaces')
          .values({
            id: 'extra',
            user_id: (await server!.db.selectFrom('users').select('id').executeTakeFirstOrThrow())
              .id,
            settings: '{}',
            address: server!.address,
            created_at: root.info.created_at,
          })
          .execute()
      ).rejects.toThrow()
    })
    it('002/004/005 server facet: same connection contract for every token, JSON hints confer no authority', async () => {
      const { key, request, issue } = await setup()
      const child = await issue(key)
      const response = await request(decodeAccessToken(child.token).key, '/v2/connection')
      expect(response.status).toBe(200)
      expect(V2ConnectionSchema.parse(response.body).scope.path).toBe('/')
      expect(JSON.stringify(response.body)).not.toMatch(/password|account|role/)
    })
    it('007/009 denies missing, malformed, unknown and directly revoked credentials', async () => {
      const { key, request, issue } = await setup()
      for (const bad of ['', 'short', 'a'.repeat(43)])
        expect((await request(bad, '/v2/connection')).status).toBe(401)
      const child = await issue(key)
      expect((await request(key, `/v2/tokens/${child.info.id}`, 'DELETE')).status).toBe(200)
      expect((await request(decodeAccessToken(child.token).key, '/v2/connection')).status).toBe(401)
      expect(
        (await request(decodeAccessToken(child.token).key, '/v2/commit', 'POST', { ops: [] }))
          .status
      ).toBe(401)
      expect((await request(decodeAccessToken(child.token).key, '/v2/manifest')).status).toBe(401)
    })
    it('011/021 issues independent root device tokens without another user; one revocation leaves peers active', async () => {
      const { key, request, issue } = await setup()
      const a = await issue(key),
        b = await issue(key)
      expect(a.token).not.toBe(b.token)
      await request(key, `/v2/tokens/${a.info.id}`, 'DELETE')
      expect((await request(decodeAccessToken(b.token).key, '/v2/connection')).status).toBe(200)
      expect(await server!.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
    })
    it('013/016/017 allows folder delegation, rejects broader, unrelated and foreign targets and reader roles', async () => {
      const { root, key, request, issue } = await setup()
      const time = root.info.created_at
      const space = (await server!.db.selectFrom('spaces').select('id').executeTakeFirstOrThrow())
        .id
      for (const [id, parent, path] of [
        ['shared', root.info.scope.id, 'Shared'],
        ['nested', 'shared', 'Shared/Nested'],
        ['other', root.info.scope.id, 'Other'],
      ]) {
        await server!.db
          .insertInto('directories')
          .values({
            id: id!,
            parent_id: parent!,
            space_id: space,
            path: path!,
            deleted_at: null,
            version_id: `${id}-v`,
            mtime: 0,
          })
          .execute()
      }
      const shared = await issue(key, 'shared')
      const guest = decodeAccessToken(shared.token).key
      const nested = await issue(guest, 'nested')
      expect((await request(decodeAccessToken(nested.token).key, '/v2/connection')).status).toBe(
        200
      )
      for (const id of [root.info.scope.id, 'other', 'missing'])
        expect(
          (
            await request(guest, '/v2/tokens', 'POST', {
              scope: { kind: 'folder', id },
              label: 'illegal',
            })
          ).status
        ).toBe(403)
      expect(
        (
          await request(key, '/v2/tokens', 'POST', {
            scope: { kind: 'folder', id: 'shared' },
            label: 'reader',
            role: 'reader',
          })
        ).status
      ).toBe(400)
      const outsider = await createUser(
        { db: server!.db, pepper: server!.config.tokenPepper },
        'Other',
        server!.address
      )
      expect(
        (
          await request(key, '/v2/tokens', 'POST', {
            scope: { kind: 'folder', id: outsider.info.scope.id },
            label: 'foreign',
          })
        ).status
      ).toBe(403)
      await server!.db
        .updateTable('directories')
        .set({ parent_id: root.info.scope.id, path: 'Escaped' })
        .where('id', '=', 'nested')
        .execute()
      const unavailable = V2ConnectionSchema.parse(
        (await request(decodeAccessToken(nested.token).key, '/v2/connection')).body
      )
      expect(unavailable.status).toBe('scope_unavailable')
      expect(unavailable.scope.path).not.toBe('Escaped')
      const restrictedList = V2TokensResponseSchema.parse((await request(guest, '/v2/tokens')).body)
      expect(restrictedList.items.find((item) => item.id === nested.info.id)?.scope.path).not.toBe(
        'Escaped'
      )
      expect(
        (
          await request(decodeAccessToken(nested.token).key, '/v2/tokens', 'POST', {
            scope: { kind: 'folder', id: 'nested' },
            label: 'escape',
          })
        ).status
      ).toBe(503)
      expect(time).toBeDefined()
    })
    it('014 group tokens bind stable note IDs and share further without registration', async () => {
      const { root, key, issue, request } = await setup()
      const space = (await server!.db.selectFrom('spaces').select('id').executeTakeFirstOrThrow())
        .id
      await server!.db
        .insertInto('files')
        .values({
          id: 'group',
          vault_id: space,
          path: 'Group.md',
          path_ci: 'group.md',
          kind: 'note',
          head_version_id: null,
          deleted_at: null,
        })
        .execute()
      const group = await issue(key, 'group', 'group')
      const delegated = await issue(decodeAccessToken(group.token).key, 'group', 'group')
      expect(
        V2ConnectionSchema.parse(
          (await request(decodeAccessToken(group.token).key, '/v2/connection')).body
        ).status
      ).toBe('active')
      await server!.db
        .updateTable('files')
        .set({ path: 'Renamed.md' })
        .where('id', '=', 'group')
        .execute()
      expect(
        V2ConnectionSchema.parse(
          (await request(decodeAccessToken(delegated.token).key, '/v2/connection')).body
        ).scope.path
      ).toBe('Renamed.md')
      await server!.db
        .updateTable('files')
        .set({ deleted_at: root.info.created_at })
        .where('id', '=', 'group')
        .execute()
      expect(
        V2ConnectionSchema.parse(
          (await request(decodeAccessToken(group.token).key, '/v2/connection')).body
        ).status
      ).toBe('scope_unavailable')
    })
    it('018/019/020 list and revoke only as issuer or any active root token, within one space', async () => {
      const { key, issue, request } = await setup()
      const peer = await issue(key)
      const child = await issue(decodeAccessToken(peer.token).key)
      const list = V2TokensResponseSchema.parse((await request(key, '/v2/tokens')).body)
      expect(list.items.map((x) => x.id)).toContain(child.info.id)
      expect(JSON.stringify(list)).not.toMatch(/key|secret_hash|token_hash/)
      expect((await request(key, `/v2/tokens/${child.info.id}`, 'DELETE')).status).toBe(200)
      expect((await request(decodeAccessToken(child.token).key, '/v2/tokens')).status).toBe(401)
      const outsider = await createUser(
        { db: server!.db, pepper: server!.config.tokenPepper },
        'Other',
        server!.address
      )
      expect(
        (
          await request(
            decodeAccessToken(outsider.token).key,
            `/v2/tokens/${peer.info.id}`,
            'DELETE'
          )
        ).status
      ).toBe(403)
    })
    it('010 server facet: reopening the durable database preserves authority and revocation', async () => {
      const { key, issue, request } = await setup()
      const child = await issue(key)
      await request(key, `/v2/tokens/${child.info.id}`, 'DELETE')
      const previous = server!.db
      await server!.restart()
      expect(server!.db).not.toBe(previous)
      expect((await request(key, '/v2/connection')).status).toBe(200)
      expect((await request(decodeAccessToken(child.token).key, '/v2/connection')).status).toBe(401)
    })
    it('disabled users cannot authenticate, issue, list or revoke', async () => {
      const { root, key, request } = await setup()
      await server!.db.updateTable('users').set({ disabled_at: root.info.created_at }).execute()
      for (const [method, path, body] of [
        ['GET', '/v2/connection'],
        ['GET', '/v2/tokens'],
        ['DELETE', `/v2/tokens/${root.info.id}`],
        ['POST', '/v2/tokens', { scope: { kind: 'folder', id: root.info.scope.id }, label: 'x' }],
      ] as const) {
        expect((await request(key, path, method, body)).status).toBe(401)
      }
    })
    it('018/021 revocation affects only that token; previously issued descendants remain active', async () => {
      const { key, issue, request } = await setup()
      const issuer = await issue(key)
      const descendant = await issue(decodeAccessToken(issuer.token).key)
      await request(key, `/v2/tokens/${issuer.info.id}`, 'DELETE')
      expect((await request(decodeAccessToken(issuer.token).key, '/v2/connection')).status).toBe(
        401
      )
      expect(
        (await request(decodeAccessToken(descendant.token).key, '/v2/connection')).status
      ).toBe(200)
      const further = await issue(decodeAccessToken(descendant.token).key)
      expect((await request(decodeAccessToken(further.token).key, '/v2/connection')).status).toBe(
        200
      )
    })
  })
}
