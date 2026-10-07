import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createScopedClient } from '@abele/sync-core'
import { runCli } from 'abele-sync/src/cli.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { createFolderGrant } from '../../src/auth/folderManagement.js'
import { readSponsoredAssets } from '../../src/scoped/assets.js'
import { readIntrinsicSponsorProof } from '../../src/scoped/sponsorProof.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `live scoped transport boundaries (${dialect})`,
    () => {
      it('redirect and cache: refuses the second listener, code paths and revoked warm principals on real TCP', async () => {
        const f = await scopedFixture(dialect),
          live = await liveScopedServer(f),
          sinkRequests: string[] = []
        const sink = createServer((req, res) => {
          sinkRequests.push(req.headers.authorization ?? 'none')
          res.end('sink')
        })
        sink.listen(0, '127.0.0.1')
        await once(sink, 'listening')
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'shared')
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'shared')])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const client = await createScopedClient({
            baseUrl: live.base,
            token: f.a.key_token,
            fetch,
            vaultId: f.vault,
            grantId: f.grant.id,
            principalId: f.a.key_id,
            principalKind: 'key',
          })
          live.faults.redirect = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/capture`
          await expect(client.state()).rejects.toMatchObject({ code: 'protocol' })
          await expect(
            client.putBlob(shaOf('secret bytes'), new TextEncoder().encode('secret bytes'))
          ).rejects.toMatchObject({ code: 'protocol' })
          expect(sinkRequests).toEqual([])
          expect(live.requests.some((row) => row.token === f.a.key_token && row.bytes === 12)).toBe(
            true
          )
          delete live.faults.redirect
          const url = `${live.base}/v1/scoped/vaults/${f.vault}/grants/${f.grant.id}/files/${note.file_id}/current`
          const get = (token: string, headers: Record<string, string> = {}) =>
            fetch(url, {
              headers: {
                authorization: `Bearer ${token}`,
                'x-abele-scoped-version': '4',
                ...headers,
              },
              cache: 'no-store',
              redirect: 'manual',
            })
          const first = await get(f.a.key_token)
          expect(await first.text()).toBe('shared')
          const etag = first.headers.get('etag')!
          await f.revoke(f.b.key_id)
          for (const headers of [{}, { range: 'bytes=0-2' }, { 'if-none-match': etag }] as Record<
            string,
            string
          >[])
            expect((await get(f.b.key_token, headers)).status).toBe(401)
          expect(await (await get(f.a.key_token)).text()).toBe('shared')
          expect(live.requests.filter((row) => row.path.endsWith('/current'))).toHaveLength(5)
          await client.putBlob(shaOf('code'), new TextEncoder().encode('code'))
          for (const path of [
            'Agents/unsafe.js',
            '.obsidian/unsafe.md',
            'Agents-private/unsafe.md',
          ])
            await expect(
              client.commit({
                request_id: path,
                ops: [{ op: 'create', path, sha: shaOf('code'), size: 4, mtime: 1 }],
              })
            ).rejects.toMatchObject({ code: 'not_found' })
          expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
          expect(
            (
              await f.t.app.inject({
                url: `/v1/scoped/vaults/${f.vault}/grants/${f.grant.id}/state`,
                headers: { 'x-abele-scoped-version': '4' },
              })
            ).statusCode
          ).toBe(503)
        } finally {
          sink.closeAllConnections()
          await new Promise<void>((resolve) => sink.close(() => resolve()))
          await live.close()
          await f.close()
        }
      })
      it('stale publication and cross grant: cannot publish old sponsor evidence, hidden occupancy or another audience path', async () => {
        const f = await scopedFixture(dialect),
          live = await liveScopedServer(f)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'note')
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'note')])
          ).results[0]
          await putBlob(f.t.app, f.device.deviceToken, 'private image')
          const image = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Attachments/private.png', 'private image'),
            ])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const proof = await readIntrinsicSponsorProof(
              live.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              note.file_id
            ),
            view = await readSponsoredAssets(live.deps, f.device.deviceToken, f.vault, f.grant.id)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: note.file_id,
              base_version_id: note.version_id,
              to_path: 'Private/n.md',
            },
          ])
          const stale = await fetch(
            `${live.base}/v1/vaults/${f.vault}/grants/${f.grant.id}/assets/add`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${f.device.deviceToken}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                grantId: f.grant.id,
                expectedRevision: view.revision,
                withdrawalGeneration: view.withdrawalGeneration,
                intentId: 'stale',
                decisionDeviceId: f.device.deviceId,
                target: {
                  fileId: image.file_id,
                  versionId: image.version_id,
                  sha: shaOf('private image'),
                  path: 'Attachments/private.png',
                  eligible: true,
                },
                sponsors: [proof.sponsor],
                reason: 'confirmed-existing',
              }),
            }
          )
          expect(stale.status).toBe(409)
          expect(
            await f.t.db.selectFrom('scope_extra_entries').select('id').execute()
          ).toHaveLength(0)
          await createFolderGrant(f.deps, f.owner.accountToken, f.vault, {
            label: 'Other',
            prefix: 'Other/',
            role: 'editor',
          })
          const client = await createScopedClient({
            baseUrl: live.base,
            token: f.a.key_token,
            fetch,
            vaultId: f.vault,
            grantId: f.grant.id,
            principalId: f.a.key_id,
            principalKind: 'key',
          })
          await client.putBlob(shaOf('private image'), new TextEncoder().encode('private image'))
          for (const path of ['Other/new.md', 'Attachments/private.png'])
            await expect(
              client.commit({
                request_id: path,
                ops: [{ op: 'create', path, sha: shaOf('private image'), size: 13, mtime: 1 }],
              })
            ).rejects.toMatchObject({ code: 'not_found' })
          expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(2)
          const sponsorNote = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/live-sponsor.md', 'note'),
            ])
          ).results[0]
          const root = `${live.base}/v1/scoped/vaults/${f.vault}/grants/${f.grant.id}`,
            headers = { authorization: `Bearer ${f.a.key_token}`, 'x-abele-scoped-version': '4' }
          const sponsor = (
            await (
              await fetch(`${root}/assets/sponsors/${sponsorNote.file_id}/proof`, { headers })
            ).json()
          ).sponsor
          const upload = await (
            await fetch(`${root}/uploads/${shaOf('private image')}/proof`, { headers })
          ).json()
          const before = await f.t.db
            .selectFrom('files')
            .select(['id', 'head_version_id'])
            .execute()
          for (const path of ['Other/native.png', 'Attachments/private.png']) {
            const response = await fetch(`${root}/assets/native`, {
              method: 'POST',
              headers: { ...headers, 'content-type': 'application/json' },
              body: JSON.stringify({
                grantId: f.grant.id,
                path,
                localCreateHandle: path,
                sha: shaOf('private image'),
                eligible: true,
                sponsor,
                upload: {
                  principalId: f.a.key_id,
                  grantId: f.grant.id,
                  sha: shaOf('private image'),
                  entitlementId: upload.entitlementId,
                },
              }),
            })
            expect(response.status).toBe(404)
          }
          expect(
            await f.t.db.selectFrom('files').select(['id', 'head_version_id']).execute()
          ).toEqual(before)
        } finally {
          await live.close()
          await f.close()
        }
      })
      it('daemon lost merge response: physical ledger restart replays one committed in-place merge', async () => {
        await mkdir(resolve(process.cwd(), 'data'), { recursive: true })
        const f = await scopedFixture(dialect),
          live = await liveScopedServer(f),
          dir = await mkdtemp(join(resolve(process.cwd(), 'data'), 'x64-agent-'))
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'one\ntwo\nthree\n')
          const note = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Agents/n.md', 'one\ntwo\nthree\n'),
            ])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          const io = { out: () => {}, err: () => {}, fetch }
          expect(
            await runCli(
              [
                'agent',
                'setup',
                '--dir',
                dir,
                '--server',
                live.base,
                '--vault',
                f.vault,
                '--grant',
                f.grant.id,
                '--principal',
                f.a.key_id,
              ],
              { ABELE_AGENT_TOKEN: f.a.key_token },
              io
            )
          ).toBe(0)
          expect(await runCli(['agent', 'run', '--once', '--dir', dir], {}, io)).toBe(0)
          await writeFile(join(dir, 'Agents', 'n.md'), 'agent\ntwo\nthree\n')
          await putBlob(f.t.app, f.device.deviceToken, 'one\ntwo\nowner\n')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: note.file_id,
              base_version_id: note.version_id,
              sha: shaOf('one\ntwo\nowner\n'),
              size: 14,
              mtime: 2,
            },
          ])
          live.faults.dropCommit = true
          expect(await runCli(['agent', 'run', '--once', '--dir', dir], {}, io)).toBe(1)
          const versions = await f.t.db.selectFrom('versions').select('id').execute(),
            receipts = await f.t.db.selectFrom('scope_receipts').select('outcome_id').execute()
          expect(receipts).toHaveLength(1)
          expect(await runCli(['agent', 'run', '--once', '--dir', dir], {}, io)).toBe(0)
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(versions)
          expect(await f.t.db.selectFrom('scope_receipts').select('outcome_id').execute()).toEqual(
            receipts
          )
          expect(await readFile(join(dir, 'Agents', 'n.md'), 'utf8')).toBe('agent\ntwo\nowner\n')
          expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
        } finally {
          await rm(dir, { recursive: true, force: true })
          await live.close()
          await f.close()
        }
      })
    }
  )
