import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { AddressInfo } from 'node:net'
import type { FastifyServerOptions } from 'fastify'
type HTTPMethods = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
import { liveScopedFacets } from '../helpers/liveScopedFacets.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { hashToken } from '../../src/auth/hash.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import policy from '../helpers/routePolicy.json' with { type: 'json' }
const inventory = vi.hoisted(() => [] as string[])
vi.mock('fastify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fastify')>()
  return {
    ...actual,
    default: (options: FastifyServerOptions) => {
      const app = actual.fastify(options)
      app.addHook('onRoute', (route) => {
        for (const method of [route.method].flat()) inventory.push(`${method} ${route.url}`)
      })
      return app
    },
  }
})
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `enumerated security matrix (${dialect})`,
    () => {
      it('requires an explicit reviewed policy for every runtime registered method/path, including implicit HEAD and WebSocket', async () => {
        inventory.length = 0
        const f = await scopedFixture(dialect)
        try {
          expect([...new Set(inventory)].sort()).toEqual(Object.keys(policy).sort())
        } finally {
          await f.close()
        }
      })
      it('probes every route with disjoint facets, foreign vault/grant, expired/revoked state and no private payload', async () => {
        const f = await scopedFixture(dialect)
        try {
          const foreign = (await f.t.vault(f.owner.accountToken, 'other')).vaultId
          const marker = 'route-matrix-private-marker'
          await putBlob(f.t.app, f.device.deviceToken, marker)
          const file = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Private/marker.md', marker),
            ])
          ).results[0]
          const live = await liveScopedFacets(f)
          const foreignDevice = await f.t.device(f.owner.accountToken, foreign, 'foreign')
          const uploadSha = shaOf('part')
          const begun = await f.t.app.inject({
            method: 'POST',
            url: `/v1/blobs/${uploadSha}/upload`,
            headers: { authorization: `Bearer ${f.device.deviceToken}` },
            payload: { size: 4 },
          })
          const uploadId = begun.json().upload_id as string
          expect(begun.statusCode).toBe(201)
          expect(
            (
              await f.t.app.inject({
                method: 'PUT',
                url: `/v1/blobs/${uploadSha}/upload/${uploadId}/0`,
                headers: {
                  authorization: `Bearer ${f.device.deviceToken}`,
                  'content-type': 'application/octet-stream',
                },
                payload: Buffer.from('part'),
              })
            ).statusCode
          ).toBe(204)
          const expiredAccount = 'abst_' + 'e'.repeat(43)
          await f.t.db
            .insertInto('account_tokens')
            .values({
              account_id: f.owner.accountId,
              token_hash: hashToken('test', expiredAccount),
              expires_at: '2029-12-31T23:59:59.000Z',
              issued_at: '2029-12-31T23:00:00.000Z',
            })
            .execute()
          const revokedDevice = await f.t.device(f.owner.accountToken, f.vault, 'revoked')
          await f.t.db
            .updateTable('devices')
            .set({ revoked_at: '2030-01-01T00:00:00.000Z' })
            .where('id', '=', revokedDevice.deviceId)
            .execute()
          await f.t.db
            .updateTable('scope_keys')
            .set({ expires_at: '2030-01-01T00:00:01.000Z' })
            .where('id', '=', f.b.key_id)
            .execute()
          f.setClock('2030-01-01T00:00:02.000Z')
          const facets = [
            undefined,
            f.owner.accountToken,
            f.device.deviceToken,
            f.a.key_token,
            f.b.key_token,
            live.installationToken,
            live.invitationToken,
            foreignDevice.deviceToken,
            'absi_' + 'i'.repeat(43),
            'absinv_' + 'n'.repeat(43),
            expiredAccount,
            revokedDevice.deviceToken,
          ]
          expect(facets).toContain(live.installationToken)
          expect(facets).toContain(live.invitationToken)
          expect(facets).toContain(foreignDevice.deviceToken)
          const covered: { route: string; url: string; token: string | undefined }[] = []
          let probes = 0
          for (const [route, kind] of Object.entries(policy)) {
            const [rawMethod, path] = route.split(' '),
              method = rawMethod as HTTPMethods
            const variants =
              kind === 'scoped' || kind === 'management'
                ? [
                    { v: f.vault, g: f.grant.id },
                    { v: foreign, g: 'wrong-grant' },
                    { v: f.vault, g: 'wrong-grant' },
                  ]
                : [{ v: f.vault, g: f.grant.id }]
            for (const params of variants)
              for (const token of facets) {
                if (
                  route === 'DELETE /v1/devices/self' &&
                  (token === f.device.deviceToken || token === foreignDevice.deviceToken)
                )
                  continue
                const multipart = path!.includes('/v1/blobs/:sha/upload/:id')
                if (multipart && token === f.device.deviceToken) continue
                // WebSocket credentials belong in hello, never bearer HTTP. Its actual
                // authenticated upgrade/expiry/revoke coverage lives in api.events.test.
                const url = path!.replace(
                  /:([a-z]+)/g,
                  (_all, key: string) =>
                    ({
                      v: params.v,
                      g: params.g,
                      f: file.file_id,
                      ver: file.version_id,
                      sha: multipart ? uploadSha : shaOf(marker),
                      part: '0',
                      id: multipart ? uploadId : 'missing',
                      s: 'missing',
                      k: 'missing',
                      m: 'missing',
                      i: 'missing',
                    })[key] ?? 'missing'
                )
                const headers: Record<string, string> = {
                  'x-abele-external-files-version': '1',
                  'x-abele-scoped-version': '4',
                  'content-type': 'application/json',
                }
                if (token) headers.authorization = `Bearer ${token}`
                if (multipart && method === 'PUT')
                  headers['content-type'] = 'application/octet-stream'
                const response = await f.t.app.inject({
                  method,
                  url,
                  headers,
                  ...(multipart && method === 'PUT'
                    ? { payload: Buffer.from('part') }
                    : ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
                      ? { payload: '{}' }
                      : {}),
                })
                covered.push({ route, url, token })
                probes++
                const context = `${route} ${kind} ${token?.slice(0, 5) ?? 'none'} ${params.v}/${params.g}`
                if (kind === 'public') expect(response.statusCode, context).toBe(200)
                else if (kind === 'login')
                  expect([400, 429], context).toContain(response.statusCode)
                else if (kind === 'scoped' || kind === 'management') {
                  expect(response.statusCode, context).toBe(503)
                  expect(response.headers['cache-control'], context).toBe('no-store')
                  if (method !== 'HEAD')
                    expect(response.json().error.code, context).toBe('scoped_unavailable')
                } else if (kind === 'websocket') expect(response.statusCode, context).toBe(404)
                else {
                  const accepted =
                    kind === 'account'
                      ? token === f.owner.accountToken
                      : token === f.device.deviceToken
                  if (kind === 'device' && token === foreignDevice.deviceToken) {
                    if (path!.includes(':v')) expect(response.statusCode, context).toBe(403)
                    else if (method === 'GET' || method === 'HEAD' || multipart)
                      expect(response.statusCode, context).toBe(404)
                    else expect(response.statusCode, context).toBe(400)
                    expect(response.body, context).not.toContain(marker)
                  } else if (!accepted) {
                    expect(response.statusCode, context).toBe(401)
                    expect(response.body, context).not.toContain(marker)
                  }
                  // Avoid exercising destructive valid DELETE self; submit only invalid
                  // facets there so subsequent probes still use a live personal device.
                }
              }
            if (kind === 'device' && path!.includes(':v')) {
              const url = path!.replace(':v', foreign).replace(/:[a-z]+/g, 'missing')
              const response = await f.t.app.inject({
                method,
                url,
                headers: {
                  authorization: `Bearer ${f.device.deviceToken}`,
                  'x-abele-external-files-version': '1',
                  'content-type': 'application/json',
                },
                ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? { payload: '{}' } : {}),
              })
              expect(response.statusCode, route + ' foreign vault').toBe(403)
              expect(response.body).not.toContain(marker)
            }
            if (kind === 'scoped') {
              const url = path!.replace(/:[a-z]+/g, 'missing')
              for (const version of [undefined, '1', '3', '04', '4,4']) {
                const response = await f.t.app.inject({
                  method,
                  url,
                  headers: version ? { 'x-abele-scoped-version': version } : {},
                })
                expect(response.statusCode, route + ' version ' + version).toBe(400)
              }
            }
          }
          for (const change of [
            { expires_at: '2030-01-01T00:00:01.000Z' },
            { revoked_at: '2030-01-01T00:00:02.000Z' },
          ]) {
            await f.t.db
              .updateTable('scope_grants')
              .set(change)
              .where('id', '=', f.grant.id)
              .execute()
            for (const [route, kind] of Object.entries(policy))
              if (kind === 'scoped' || kind === 'management') {
                const [method, path] = route.split(' '),
                  url = path!
                    .replace(':v', f.vault)
                    .replace(':g', f.grant.id)
                    .replace(/:[a-z]+/g, 'missing')
                const result = await f.t.app.inject({
                  method: method as HTTPMethods,
                  url,
                  headers: {
                    authorization: `Bearer ${f.a.key_token}`,
                    'x-abele-scoped-version': '4',
                    'content-type': 'application/json',
                  },
                  ...(['POST', 'PATCH', 'PUT', 'DELETE'].includes(method!)
                    ? { payload: '{bad json' }
                    : {}),
                })
                expect(result.statusCode, route + ' expired/revoked grant').toBe(503)
              }
          }
          for (const method of ['GET', 'HEAD'])
            expect(
              covered.some(
                (probe) =>
                  probe.route === `${method} /v1/blobs/:sha` &&
                  probe.token === foreignDevice.deviceToken &&
                  probe.url.endsWith(shaOf(marker))
              )
            ).toBe(true)
          for (const method of ['PUT', 'POST'])
            expect(
              covered.some(
                (probe) =>
                  probe.route.startsWith(`${method} /v1/blobs/:sha/upload/:id`) &&
                  probe.token === foreignDevice.deviceToken &&
                  probe.url.includes(uploadId)
              )
            ).toBe(true)
          expect(
            await f.t.db.selectFrom('uploads').select('id').where('id', '=', uploadId).execute()
          ).toHaveLength(1)
          expect(probes).toBeGreaterThan(Object.keys(policy).length * 9)
        } finally {
          await f.close()
        }
      })
      it('checks the enumerated WebSocket endpoint with actual upgrades and disjoint hello facets/foreign vault', async () => {
        const f = await scopedFixture(dialect),
          sockets: WebSocket[] = []
        try {
          await f.t.app.listen({ host: '127.0.0.1', port: 0 })
          const port = (f.t.app.server.address() as AddressInfo).port
          const foreign = (await f.t.vault(f.owner.accountToken)).vaultId
          const live = await liveScopedFacets(f)
          for (const [token, vault] of [
            [f.owner.accountToken, f.vault],
            [f.a.key_token, f.vault],
            [live.installationToken, f.vault],
            [live.invitationToken, f.vault],
            ['absi_' + 'i'.repeat(43), f.vault],
            ['absinv_' + 'n'.repeat(43), f.vault],
            [f.device.deviceToken, foreign],
          ]) {
            const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/vaults/${vault}/events`)
            sockets.push(socket)
            const closed = new Promise<number>((resolve) => socket.once('close', resolve))
            socket.on('error', () => {})
            await new Promise<void>((resolve, reject) => {
              socket.once('open', () => resolve())
              socket.once('error', reject)
            })
            socket.send(JSON.stringify({ token }))
            expect(await closed).toBe(4001)
          }
          expect(f.t.hub.sockets(f.vault)).toBe(0)
        } finally {
          for (const socket of sockets) socket.terminate()
          await f.close()
        }
      })
    }
  )
