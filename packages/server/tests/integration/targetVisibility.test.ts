import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { loadConfig } from '../../src/config.js'
import { errorHandler, notFoundHandler } from '../../src/api/errors.js'
import { registerSponsoredAssetRoutes } from '../../src/api/routes/sponsoredAssets.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { readIntrinsicSponsorProof } from '../../src/scoped/sponsorProof.js'
import { addSponsoredAsset, mutateSponsoredAssets } from '../../src/scoped/assets.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { readScopedUploadProof, createNativeSponsoredAsset } from '../../src/scoped/nativeAssets.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { updateFolderGrant } from '../../src/auth/folderManagement.js'
import { createGroupGrant } from '../../src/auth/groupManagement.js'
import { prepareGroupBootstrap } from '../../src/scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../src/scoped/groups/worker.js'

async function fixture(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  // Exercise the real route without opening the production activation fence.
  const app = Fastify()
  const config = loadConfig({ ABELE_MASTER_KEY: 'ab'.repeat(32), ABELE_TOKEN_PEPPER: 'test' })
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)
  registerSponsoredAssetRoutes(app, { ...f.deps, config })
  const path = (file: string, vault = f.vault, grant = f.grant.id) =>
    `/v1/vaults/${vault}/grants/${grant}/assets/visibility/${file}`
  return {
    ...f,
    config,
    app,
    path,
    read: (file: string, token: string | undefined = f.device.deviceToken, grant = f.grant.id) =>
      api(app, token).get(path(file, f.vault, grant)),
    async file(path: string, text = path) {
      await putBlob(f.t.app, f.device.deviceToken, text)
      return (await commit(f.t.app, f.device.deviceToken, f.vault, [create(path, text)])).results[0]
    },
    async close() {
      await app.close()
      await f.close()
    },
  }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`target visibility (${dialect})`, () => {
    it('reads intrinsic notes/binaries and private targets, agreeing with the scoped snapshot', async () => {
      const f = await fixture(dialect)
      try {
        const note = await f.file('Agents/n.md'),
          binary = await f.file('Agents/p.png'),
          privateFile = await f.file('Private/p.png')
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const snapshot = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
        for (const target of [note, binary, privateFile]) {
          const visible = snapshot.items.some((item) => item.file_id === target.file_id)
          const res = await f.read(target.file_id)
          expect(res.status).toBe(200)
          expect(res.headers['cache-control']).toBe('no-store')
          expect(res.body).toEqual({
            grantId: f.grant.id,
            label: 'Agents',
            targetFileId: target.file_id,
            visible,
            targetVersionId: visible ? target.version_id : null,
            scopeRevision: expect.any(Number),
            revision: 0,
            withdrawalGeneration: 0,
          })
        }
        await updateFolderGrant(f.deps, f.owner.accountToken, f.vault, f.grant.id, {
          expected_revision: 0,
          label: 'Renamed audience',
        })
        expect((await f.read(note.file_id)).body.label).toBe('Renamed audience')
      } finally {
        await f.close()
      }
    })
    it('includes owner extras and native assets, then excludes withdrawn targets', async () => {
      const f = await fixture(dialect)
      try {
        const note = await f.file('Agents/n.md'),
          extra = await f.file('Attachments/e.png')
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const proof = await readIntrinsicSponsorProof(
          f.deps,
          f.device.deviceToken,
          f.vault,
          f.grant.id,
          note.file_id
        )
        const published = await addSponsoredAsset(
          f.deps,
          f.device.deviceToken,
          f.vault,
          f.grant.id,
          {
            grantId: f.grant.id,
            expectedRevision: 0,
            withdrawalGeneration: 0,
            intentId: 'publish',
            decisionDeviceId: f.device.deviceId,
            target: {
              fileId: extra.file_id,
              versionId: extra.version_id,
              sha: shaOf('Attachments/e.png'),
              path: 'Attachments/e.png',
              eligible: true,
            },
            sponsors: [proof.sponsor],
            reason: 'confirmed-existing',
          }
        )
        const sha = shaOf('native')
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          sha,
          Buffer.from('native')
        )
        const upload = await readScopedUploadProof(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
        const native = await createNativeSponsoredAsset(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          {
            grantId: f.grant.id,
            path: 'Attachments/n.png',
            localCreateHandle: 'native',
            sha,
            eligible: true,
            sponsor: proof.sponsor,
            upload: {
              principalId: f.a.key_id,
              grantId: f.grant.id,
              sha,
              entitlementId: upload.entitlementId,
            },
          }
        )
        const snapshot = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
        for (const id of [extra.file_id, native.fileId]) {
          expect(snapshot.items.some((item) => item.file_id === id)).toBe(true)
          const res = await f.read(id)
          expect(res.status).toBe(200)
          expect(res.body).toMatchObject({
            visible: true,
            targetVersionId: snapshot.items.find((item) => item.file_id === id)!.version_id,
          })
        }
        const current = (await f.read(extra.file_id)).body
        expect(current.revision).toBeGreaterThanOrEqual(published.revision)
        const withdrawn = await mutateSponsoredAssets(
          f.deps,
          f.device.deviceToken,
          f.vault,
          f.grant.id,
          {
            expectedRevision: current.revision,
            intentId: 'withdraw',
            delta: {
              kind: 'withdraw',
              fileId: extra.file_id,
              expectedGeneration: current.withdrawalGeneration,
            },
          }
        )
        expect((await f.read(extra.file_id)).body).toMatchObject({
          visible: false,
          targetVersionId: null,
          revision: withdrawn.revision,
          withdrawalGeneration: withdrawn.withdrawalGeneration,
        })
        const after = await openFolderSnapshot(f.deps, f.b.key_token, f.vault, f.grant.id)
        expect(after.items.some((item) => item.file_id === extra.file_id)).toBe(false)
      } finally {
        await f.close()
      }
    })
    it('does not treat a stale membership row as security authority', async () => {
      const f = await fixture(dialect)
      try {
        const target = await f.file('Agents/p.png')
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        // Configuration policy can change independently of stored admission rows.
        f.config.configurationDirectories = ['Agents']
        expect((await f.read(target.file_id)).body).toMatchObject({
          visible: false,
          targetVersionId: null,
        })
        await expect(
          openFolderSnapshot({ ...f.deps, config: f.config }, f.a.key_token, f.vault, f.grant.id)
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
      } finally {
        await f.close()
      }
    })
    it('reports deleted targets as invisible, and missing/foreign-vault identities as 404', async () => {
      const f = await fixture(dialect)
      try {
        const target = await f.file('Agents/n.md')
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          { op: 'delete', file_id: target.file_id, base_version_id: target.version_id },
        ])
        expect((await f.read(target.file_id)).body).toMatchObject({
          visible: false,
          targetVersionId: null,
        })
        const otherVault = (await f.t.vault(f.owner.accountToken)).vaultId,
          otherDevice = await f.t.device(f.owner.accountToken, otherVault)
        await putBlob(f.t.app, otherDevice.deviceToken, 'foreign')
        const foreign = (
          await commit(f.t.app, otherDevice.deviceToken, otherVault, [create('n.md', 'foreign')])
        ).results[0]
        for (const id of ['missing', foreign.file_id]) expect((await f.read(id)).status).toBe(404)
        expect(
          (await api(f.app, f.device.deviceToken).get(f.path(target.file_id, otherVault))).status
        ).toBe(403)
      } finally {
        await f.close()
      }
    })
    it('refuses preparing folder/group scopes and accepts a certified group root', async () => {
      const f = await fixture(dialect)
      try {
        const root = await f.file('Root.md')
        expect((await f.read(root.file_id)).body.error.code).toBe('scope_updating')
        const group = await createGroupGrant(f.deps, f.owner.accountToken, f.vault, {
          label: 'Group',
          root_file_id: root.file_id,
          expected_root_version: root.version_id,
          role: 'editor',
        })
        expect((await f.read(root.file_id, f.device.deviceToken, group.id)).body.error.code).toBe(
          'scope_updating'
        )
        await prepareGroupBootstrap(f.deps, f.owner.accountToken, f.vault)
        await processGroupDirtyPage(f.deps, f.vault)
        const res = await f.read(root.file_id, f.device.deviceToken, group.id)
        expect(res.status).toBe(200)
        expect(res.body).toMatchObject({
          label: 'Group',
          visible: true,
          targetVersionId: root.version_id,
        })
        await f.file('Private/new.md')
        expect((await f.read(root.file_id, f.device.deviceToken, group.id)).body.error.code).toBe(
          'scope_updating'
        )
      } finally {
        await f.close()
      }
    })
    it('refuses wrong credential kinds, revoked devices, and revoked/expired grants', async () => {
      const f = await fixture(dialect)
      try {
        const target = await f.file('Agents/n.md')
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        for (const token of [f.owner.accountToken, f.a.key_token, 'absd_invalid', '']) {
          const res = await f.read(target.file_id, token)
          expect(res.status).toBe(401)
          expect(res.headers['cache-control']).toBe('no-store')
        }
        await f.t.db
          .updateTable('scope_grants')
          .set({ expires_at: '2029-01-01T00:00:00.000Z' })
          .where('id', '=', f.grant.id)
          .execute()
        expect((await f.read(target.file_id)).status).toBe(404)
        await f.t.db
          .updateTable('scope_grants')
          .set({ expires_at: null })
          .where('id', '=', f.grant.id)
          .execute()
        await updateFolderGrant(f.deps, f.owner.accountToken, f.vault, f.grant.id, {
          expected_revision: 0,
          revoke: true,
        })
        expect((await f.read(target.file_id)).status).toBe(404)
        await api(f.t.app, f.device.deviceToken).del('/v1/devices/self')
        expect((await f.read(target.file_id)).status).toBe(401)
      } finally {
        await f.close()
      }
    })
    it('leaves the production activation fence closed on the new route', async () => {
      const f = await fixture(dialect)
      try {
        const res = await api(f.t.app, f.device.deviceToken).get(f.path('any'))
        expect(res.status).toBe(503)
        expect(res.body.error.code).toBe('scoped_unavailable')
        expect(res.headers['cache-control']).toBe('no-store')
      } finally {
        await f.close()
      }
    })
  })
