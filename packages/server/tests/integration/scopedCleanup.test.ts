import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile, lstat, rename, rm } from 'node:fs/promises'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { beginScopedUpload, putScopedPart } from '../../src/scoped/multipart.js'
import { commitScoped } from '../../src/scoped/commits.js'
import { openFolderSnapshot } from '../../src/scoped/snapshots.js'
import { pollFolderFeed } from '../../src/scoped/feed.js'
import { cleanupScopedVault, cleanupScopedPartOrphans } from '../../src/scoped/cleanup.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`bounded scoped cleanup (${dialect})`, () => {
    it('expires reservations/physical parts and payloads without erasing committed outcome identity or another live principal', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('note'),
          Buffer.from('note')
        )
        const response = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'committed',
          [create('Agents/note.md', 'note')]
        )
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
        await uploadScopedBlob(
          f.deps,
          f.b.key_token,
          f.vault,
          f.grant.id,
          shaOf('keep'),
          Buffer.from('keep')
        )
        const liveUpload = await beginScopedUpload(
          f.deps,
          f.b.key_token,
          f.vault,
          f.grant.id,
          shaOf('live'),
          4
        )
        await putScopedPart(
          f.deps,
          f.b.key_token,
          f.vault,
          f.grant.id,
          liveUpload.upload_id,
          0,
          Buffer.from('live')
        )
        await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
        f.setClock('2030-01-01T00:06:00.000Z')
        await openFolderSnapshot(f.deps, f.b.key_token, f.vault, f.grant.id)
        await f.t.db
          .updateTable('scope_uploads')
          .set({ created_at: '2029-12-31T00:00:00.000Z', expires_at: '2030-01-01T00:00:00.000Z' })
          .where('id', '=', upload.upload_id)
          .execute()
        await f.t.db
          .updateTable('scope_receipts')
          .set({
            created_at: '2029-12-31T00:00:00.000Z',
            payload_expires_at: '2030-01-01T00:00:00.000Z',
          })
          .execute()
        await cleanupScopedVault(f.deps, f.vault, { limit: 10 })
        expect(
          await lstat(join(f.deps.store.dir, 'scoped-upload-parts', upload.upload_id)).catch(
            () => null
          )
        ).toBeNull()
        const receipt = await f.t.db
          .selectFrom('scope_receipts')
          .selectAll()
          .executeTakeFirstOrThrow()
        expect(receipt.outcome_id).toBe(response.outcome_id)
        expect(receipt.response).toBeNull()
        expect(
          (await f.t.db.selectFrom('scope_blob_uploads').select('principal_id').execute()).map(
            (row) => row.principal_id
          )
        ).toContain(f.b.key_id)
        const replay = await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'committed', [
          create('Agents/note.md', 'note'),
        ])
        expect(replay.acknowledged).toBe(true)
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
        const orphan = join(f.deps.store.dir, 'scoped-upload-parts', 'orphan')
        await mkdir(orphan, { recursive: true })
        await writeFile(join(orphan, '0'), 'orphan')
        await cleanupScopedPartOrphans(f.deps, 10)
        expect(await lstat(orphan).catch(() => null)).toBeNull()
        expect(
          (
            await lstat(join(f.deps.store.dir, 'scoped-upload-parts', liveUpload.upload_id))
          ).isDirectory()
        ).toBe(true)
        expect(await f.t.db.selectFrom('scope_snapshots').select('principal_id').execute()).toEqual(
          [{ principal_id: f.b.key_id }]
        )
      } finally {
        await f.close()
      }
    })
    it('does not lose retryable reservation metadata when the parts root cannot be safely inspected', async () => {
      const f = await scopedFixture(dialect)
      try {
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
        await f.t.db
          .updateTable('scope_uploads')
          .set({ created_at: '2029-12-31T00:00:00.000Z', expires_at: '2030-01-01T00:00:00.000Z' })
          .where('id', '=', upload.upload_id)
          .execute()
        const root = join(f.deps.store.dir, 'scoped-upload-parts'),
          parked = join(f.deps.store.dir, 'parked-parts')
        await rename(root, parked)
        await writeFile(root, 'not a directory')
        await expect(cleanupScopedVault(f.deps, f.vault)).rejects.toMatchObject({
          code: 'scope_unavailable',
        })
        expect(await f.t.db.selectFrom('scope_uploads').select('id').execute()).toEqual([
          { id: upload.upload_id },
        ])
        await rm(root)
        await rename(parked, root)
        await cleanupScopedVault(f.deps, f.vault)
        expect(await lstat(join(root, upload.upload_id)).catch(() => null)).toBeNull()
      } finally {
        await f.close()
      }
    })
    it('prunes a contiguous feed prefix and requires safe resnapshot instead of bridging missing progress', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'note')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const snapshot = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)
        for (let i = 0; i < 3; i++) {
          await putBlob(f.t.app, f.device.deviceToken, `note-${i}`)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: first.file_id,
              base_version_id: first.version_id,
              sha: shaOf(`note-${i}`),
              size: 6,
              mtime: i + 2,
            },
          ])
        }
        await cleanupScopedVault(f.deps, f.vault, { limit: 100, feedKeep: 1 })
        await expect(
          pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, snapshot.checkpoint)
        ).rejects.toMatchObject({ code: 'scope_unavailable' })
      } finally {
        await f.close()
      }
    })
  })
