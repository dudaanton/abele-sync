import { describe, expect, it, vi } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sql, type KyselyPlugin } from 'kysely'
import { beginScopedUpload, putScopedPart } from '../../src/scoped/multipart.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { readSponsoredAssets } from '../../src/scoped/assets.js'
import { readIntrinsicSponsorProof } from '../../src/scoped/sponsorProof.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
const gate = () => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    release: () => resolve(),
  }
}
async function waiting(f: Awaited<ReturnType<typeof scopedFixture>>) {
  for (let n = 0; n < 100; n++) {
    const rows =
      await sql`select 1 from pg_locks where locktype='advisory' and not granted and pid in(select pid from pg_stat_activity where datname=current_database())`.execute(
        f.t.db
      )
    if (rows.rows.length) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return false
}
describe.skipIf(!hasPgTestDb)('independent-process scoped publication and revocation', () => {
  for (const mode of ['range', 'merge', 'upload', 'multipart', 'snapshot', 'publication'] as const)
    it(`independent process revoke during in-flight ${mode} publication`, async () => {
      const f = await scopedFixture('pg'),
        live = await liveScopedServer(f),
        entered = gate(),
        release = gate()
      let child: ChildProcess | undefined,
        request: Promise<Response> | undefined,
        done: Promise<unknown> | undefined,
        publicationBody: string | undefined
      try {
        const base = 'one\ntwo\nthree\n'
        await putBlob(f.t.app, f.device.deviceToken, base)
        const note = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', base)])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const root = `${live.base}/v1/scoped/vaults/${f.vault}/grants/${f.grant.id}`,
          headers = { authorization: `Bearer ${f.a.key_token}`, 'x-abele-scoped-version': '4' }
        const incoming = 'agent\ntwo\nthree\n'
        if (mode === 'merge') {
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
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf(incoming),
            Buffer.from(incoming)
          )
        }
        if (mode === 'multipart') {
          const upload = await beginScopedUpload(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('part'),
            4
          )
          await putScopedPart(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            upload.upload_id,
            0,
            Buffer.from('part')
          )
          const chunks = f.t.store.putChunks.bind(f.t.store)
          vi.spyOn(f.t.store, 'putChunks').mockImplementation(async (...args) => {
            entered.release()
            await release.promise
            return chunks(...args)
          })
          request = fetch(`${root}/uploads/${shaOf('part')}/${upload.upload_id}/complete`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: '{}',
          })
        } else if (mode === 'snapshot') {
          await putBlob(f.t.app, f.device.deviceToken, 'other')
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/other.md', 'other')])
          const first = await openFolderSnapshot(live.deps, f.a.key_token, f.vault, f.grant.id, 1),
            ids = new Set<object>()
          const plugin: KyselyPlugin = {
            transformQuery(args) {
              if (
                args.node.kind === 'SelectQueryNode' &&
                JSON.stringify(args.node).includes('scope_snapshot_items')
              )
                ids.add(args.queryId)
              return args.node
            },
            async transformResult(args) {
              if (ids.has(args.queryId)) {
                entered.release()
                await release.promise
              }
              return args.result
            },
          }
          await live.useDatabase(f.t.db.withPlugin(plugin))
          request = fetch(
            `${root}/snapshots/${first.snapshot_id}?cursor=${encodeURIComponent(first.next_cursor!)}`,
            { headers }
          )
        } else if (mode === 'publication') {
          await putBlob(f.t.app, f.device.deviceToken, 'image')
          const image = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Attachments/image.png', 'image'),
            ])
          ).results[0]
          const proof = await readIntrinsicSponsorProof(
              live.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              note.file_id
            ),
            view = await readSponsoredAssets(live.deps, f.device.deviceToken, f.vault, f.grant.id)
          const ids = new Set<object>(),
            plugin: KyselyPlugin = {
              transformQuery(args) {
                if (
                  args.node.kind === 'InsertQueryNode' &&
                  JSON.stringify(args.node).includes('scope_extra_entries')
                )
                  ids.add(args.queryId)
                return args.node
              },
              async transformResult(args) {
                if (ids.has(args.queryId)) {
                  entered.release()
                  await release.promise
                }
                return args.result
              },
            }
          await live.useDatabase(f.t.db.withPlugin(plugin))
          publicationBody = JSON.stringify({
            grantId: f.grant.id,
            expectedRevision: view.revision,
            withdrawalGeneration: view.withdrawalGeneration,
            intentId: 'publication-race',
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
          request = fetch(`${live.base}/v1/vaults/${f.vault}/grants/${f.grant.id}/assets/add`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${f.device.deviceToken}`,
              'content-type': 'application/json',
            },
            body: publicationBody,
          })
        } else if (mode === 'upload') {
          const put = f.t.store.put.bind(f.t.store)
          vi.spyOn(f.t.store, 'put').mockImplementation(async (...args) => {
            entered.release()
            await release.promise
            return put(...args)
          })
          request = fetch(`${root}/uploads/${shaOf('new')}`, {
            method: 'PUT',
            headers: { ...headers, 'content-type': 'application/octet-stream' },
            body: 'new',
          })
        } else {
          const get = f.t.store.get.bind(f.t.store)
          vi.spyOn(f.t.store, 'get').mockImplementation(async (sha) => {
            entered.release()
            await release.promise
            return get(sha)
          })
          request =
            mode === 'range'
              ? fetch(`${root}/files/${note.file_id}/current`, {
                  headers: { ...headers, range: 'bytes=0-2' },
                })
              : fetch(`${root}/commit`, {
                  method: 'POST',
                  headers: { ...headers, 'content-type': 'application/json' },
                  body: JSON.stringify({
                    request_id: 'merged',
                    ops: [
                      {
                        op: 'modify',
                        file_id: note.file_id,
                        base_version_id: note.version_id,
                        sha: shaOf(incoming),
                        size: incoming.length,
                        mtime: 3,
                      },
                    ],
                  }),
                })
        }
        await entered.promise
        child = fork(
          fileURLToPath(new URL('../helpers/scopedRevokeWorker.mjs', import.meta.url)),
          [],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
        )
        const started = gate()
        done = new Promise((resolve, reject) => {
          child!.on('message', (message: any) => {
            if (message.started) started.release()
            if (message.done) resolve(message)
            if (message.error) reject(new Error(message.error))
          })
          child!.once('error', reject)
        })
        child.send({
          url: f.t.databaseUrl,
          owner: f.owner.accountToken,
          vault: f.vault,
          grant: f.grant.id,
          key: f.a.key_id,
          target: mode === 'publication' ? 'grant' : 'key',
          at: f.deps.now().toISOString(),
        })
        await started.promise
        expect(await waiting(f)).toBe(true)
        release.release()
        const response = await request
        expect(response.status).toBe(
          mode === 'range' ? 206 : mode === 'upload' || mode === 'multipart' ? 201 : 200
        )
        await response.arrayBuffer()
        await done
        for (const conditional of [
          {},
          { range: 'bytes=0-2' },
          { 'if-none-match': `"${shaOf(base)}"` },
        ] as Record<string, string>[])
          expect(
            (
              await fetch(`${root}/files/${note.file_id}/current`, {
                headers: { ...headers, ...conditional },
                cache: 'no-store',
              })
            ).status
          ).toBe(401)
        if (mode === 'publication')
          expect(
            (
              await fetch(`${live.base}/v1/vaults/${f.vault}/grants/${f.grant.id}/assets/add`, {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${f.device.deviceToken}`,
                  'content-type': 'application/json',
                },
                body: publicationBody,
              })
            ).status
          ).toBe(404)
        if (mode === 'merge')
          expect(
            (
              await fetch(`${root}/commit`, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({
                  request_id: 'merged',
                  ops: [
                    {
                      op: 'modify',
                      file_id: note.file_id,
                      base_version_id: note.version_id,
                      sha: shaOf(incoming),
                      size: incoming.length,
                      mtime: 3,
                    },
                  ],
                }),
              })
            ).status
          ).toBe(401)
        expect(
          await f.t.db
            .selectFrom('scope_blob_uploads')
            .select('sha')
            .where('principal_id', '=', f.a.key_id)
            .execute()
        ).toEqual([])
      } finally {
        release.release()
        await Promise.allSettled([request, done].filter(Boolean))
        vi.restoreAllMocks()
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
          child.kill('SIGTERM')
          await closed
        }
        await live.close()
        await f.close()
      }
    })
})
