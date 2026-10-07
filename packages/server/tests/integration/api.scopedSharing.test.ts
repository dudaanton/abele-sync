import { describe, expect, it, vi } from 'vitest'
import { createScopedClient } from '@abele/sync-core'
import { SCOPED_LIMITS, SCOPED_REQUIRED_CAPABILITIES } from '@abele/sync-protocol'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`switched scoped HTTP (${dialect})`, () => {
    it('prepares an owner-created folder and round trips scoped bytes without fixture preparation', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const request = async (path: string, token?: string, body?: unknown) => {
          const response = await fetch(live.base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              'x-abele-scoped-version': '4',
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          expect(response.ok, `${path}: ${response.status}`).toBe(true)
          expect(response.headers.get('cache-control')).toBe('no-store')
          return response.json()
        }
        expect(await request('/v1/capabilities')).toEqual({
          protocol_version: 1,
          device: true,
          scoped: {
            enabled: true,
            protocol_version: 4,
            modes: { folder: true, group: true },
            features: Object.fromEntries(SCOPED_REQUIRED_CAPABILITIES.map((name) => [name, true])),
            limits: SCOPED_LIMITS,
          },
        })
        await putBlob(f.t.app, f.device.deviceToken, 'existing')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Team/existing.md', 'existing'),
        ])
        const ownerBase = `/v1/vaults/${f.vault}/grants`
        const recipient = await f.t.account()
        for (const [token, status] of [
          [undefined, 401],
          [f.device.deviceToken, 401],
          [f.a.key_token, 401],
          [recipient.accountToken, 403],
        ] as const) {
          const denied = await fetch(`${live.base}${ownerBase}/${f.grant.id}/prepare`, {
            method: 'POST',
            headers: token ? { authorization: `Bearer ${token}` } : {},
          })
          expect(denied.status).toBe(status)
        }
        expect(
          (await request(`${ownerBase}/${f.grant.id}/prepare`, f.owner.accountToken, {})).state
        ).toBe('active')
        const grant = await request(ownerBase, f.owner.accountToken, {
          label: 'HTTP agents',
          prefix: 'Team/',
          role: 'editor',
        })
        const key = await request(`${ownerBase}/${grant.id}/keys`, f.owner.accountToken, {
          attempt_id: 'http-key',
          name: 'HTTP agent',
          role: 'editor',
          expires_at: '2030-01-02T00:00:00.000Z',
        })
        const client = await createScopedClient({
          baseUrl: live.base,
          fetch,
          token: key.key_token,
          vaultId: f.vault,
          grantId: grant.id,
          principalId: key.key_id,
          principalKind: 'key',
        })
        expect((await client.negotiate()).state.state).toBe('active')
        const snapshot = await client.openSnapshot()
        expect(snapshot.items.map((item) => item.path)).toContain('Team/existing.md')
        await client.putBlob(shaOf('from agent'), new TextEncoder().encode('from agent'))
        const result = await client.commit({
          request_id: 'http-create',
          ops: [
            {
              op: 'create',
              path: 'Team/from-agent.md',
              sha: shaOf('from agent'),
              size: 10,
              mtime: 1,
            },
          ],
        })
        const file = result.results[0]!
        const response = await fetch(
          `${live.base}/v1/scoped/vaults/${f.vault}/grants/${grant.id}/files/${file.file_id}/current`,
          {
            headers: { authorization: `Bearer ${key.key_token}`, 'x-abele-scoped-version': '4' },
          }
        )
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('from agent')
        for (const version of [undefined, '3', '04']) {
          const denied = await fetch(
            `${live.base}/v1/scoped/vaults/${f.vault}/grants/${grant.id}/state`,
            {
              headers: {
                authorization: `Bearer ${key.key_token}`,
                ...(version === undefined ? {} : { 'x-abele-scoped-version': version }),
              },
            }
          )
          expect(denied.status).toBe(400)
          expect((await denied.json()).error.code).toBe('unsupported_scoped_protocol')
        }
        const wrongFacet = await fetch(`${live.base}/v1/vaults/${f.vault}/state`, {
          headers: { authorization: `Bearer ${key.key_token}` },
        })
        expect(wrongFacet.status).toBe(401)
      } finally {
        await live.close()
        await f.close()
      }
    })
    it('prepares group membership, publishes an asset and advances group views after owner writes', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      try {
        const request = async (path: string, token: string, body?: unknown) => {
          const response = await fetch(live.base + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'x-abele-scoped-version': '4',
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          expect(response.ok, `${path}: ${response.status}`).toBe(true)
          return response.json()
        }
        await putBlob(f.t.app, f.device.deviceToken, 'root')
        const root = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Project/Root.md', 'root')])
        ).results[0]!
        const grant = await request(`/v1/vaults/${f.vault}/grants/groups`, f.owner.accountToken, {
          label: 'HTTP group',
          root_file_id: root.file_id,
          expected_root_version: root.version_id,
          role: 'editor',
        })
        const groupBase = `/v1/vaults/${f.vault}/grants/groups/${grant.id}`
        const recipient = await f.t.account()
        const invitation = await request(`${groupBase}/invitations`, f.owner.accountToken, {
          intended_account_id: recipient.accountId,
          role: 'editor',
          expires_at: '2030-01-02T00:00:00.000Z',
        })
        await request('/v1/invitations/accept', recipient.accountToken, {
          invitation_token: invitation.invitation_token,
        })
        const installation = await request(
          `/v1/scoped/grants/${grant.id}/installations`,
          recipient.accountToken,
          {
            attempt_id: 'http-install',
            name: 'HTTP group member',
            platform: 'desktop',
            role: 'editor',
            expires_at: '2030-01-02T00:00:00.000Z',
          }
        )
        const scopedBase = `/v1/scoped/vaults/${f.vault}/grants/${grant.id}`
        expect((await request(`${scopedBase}/state`, installation.installation_token)).state).toBe(
          'active'
        )
        expect(
          (await request(`${scopedBase}/snapshots`, installation.installation_token, {})).items.map(
            (item: { path: string }) => item.path
          )
        ).toContain('Project/Root.md')
        await putBlob(f.t.app, f.device.deviceToken, 'image')
        const image = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Attachments/image.png', 'image'),
          ])
        ).results[0]!
        const assetsBase = `/v1/vaults/${f.vault}/grants/${grant.id}/assets`
        await vi.waitFor(
          async () => {
            const response = await fetch(
              live.base + `${assetsBase}/sponsors/${root.file_id}/proof`,
              { headers: { authorization: `Bearer ${f.device.deviceToken}` } }
            )
            expect(response.status).toBe(200)
          },
          { timeout: 5000 }
        )
        const proof = await request(
          `${assetsBase}/sponsors/${root.file_id}/proof`,
          f.device.deviceToken
        )
        const view = await request(assetsBase, f.device.deviceToken)
        await request(`${assetsBase}/add`, f.device.deviceToken, {
          grantId: grant.id,
          expectedRevision: view.revision,
          withdrawalGeneration: view.withdrawalGeneration,
          intentId: 'http-publication',
          decisionDeviceId: f.device.deviceId,
          target: {
            fileId: image.file_id,
            versionId: image.version_id,
            sha: shaOf('image'),
            path: 'Attachments/image.png',
            eligible: true,
          },
          sponsors: [proof.sponsor],
          reason: 'confirmed-existing',
        })
        const published = await fetch(live.base + `${scopedBase}/files/${image.file_id}/current`, {
          headers: {
            authorization: `Bearer ${installation.installation_token}`,
            'x-abele-scoped-version': '4',
          },
        })
        expect(published.status).toBe(200)
        expect(await published.text()).toBe('image')
        // Restart the app/worker: group maintenance must rediscover persisted vaults,
        // not depend on the harness's in-memory groupVaults set.
        await live.useDatabase(f.t.db)
        await putBlob(f.t.app, f.device.deviceToken, 'updated root')
        const updated = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: root.file_id,
              base_version_id: root.version_id,
              sha: shaOf('updated root'),
              size: 12,
              mtime: 2,
            },
          ])
        ).results[0]!
        await vi.waitFor(
          async () => {
            const head = await request(
              `${scopedBase}/files/${root.file_id}/head`,
              installation.installation_token
            )
            expect(head.version_id).toBe(updated.version_id)
          },
          { timeout: 5000 }
        )
      } finally {
        await live.close()
        await f.close()
      }
    })
  })
