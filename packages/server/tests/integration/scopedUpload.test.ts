import { describe, expect, it, vi } from 'vitest'
import {
  uploadScopedBlob,
  requireScopedUpload,
  consumeScopedUpload,
} from '../../src/scoped/uploads.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { putBlob, shaOf } from '../helpers/ops.js'
import { collectUnreferenced } from '../../src/blobs/pending.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetention } from '../../src/history/retention.js'
import { updateVaultSettings } from '../../src/vault/vaults.js'
import { hashToken } from '../../src/auth/hash.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped upload proof (${dialect})`, () => {
    it('requires actual uploaded bytes, not guessed/private hashes or personal entitlements', async () => {
      const f = await scopedFixture(dialect)
      try {
        const sha = await putBlob(f.t.app, f.device.deviceToken, 'private')
        const hidden = await requireScopedUpload(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          sha
        ).catch((error) => error.toBody())
        const missing = await requireScopedUpload(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'a'.repeat(64)
        ).catch((error) => error.toBody())
        expect(hidden).toEqual(missing)
        expect(hidden.error.code).toBe('not_found')
        await expect(
          uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            sha,
            Buffer.from('different')
          )
        ).rejects.toMatchObject({ code: 'hash_mismatch' })
        await expect(
          uploadScopedBlob(
            f.deps,
            f.device.deviceToken,
            f.vault,
            f.grant.id,
            sha,
            Buffer.from('private')
          )
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
    it('keeps separate same-SHA entitlements and consumes/revokes only the owning principal', async () => {
      const f = await scopedFixture(dialect)
      try {
        const bytes = Buffer.from('shared bytes'),
          sha = shaOf(bytes)
        expect(
          await uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, bytes)
        ).toEqual({ sha, size: bytes.length })
        expect(
          await uploadScopedBlob(f.deps, f.b.key_token, f.vault, f.grant.id, sha, bytes)
        ).toEqual({ sha, size: bytes.length })
        expect(await f.t.db.selectFrom('scope_blob_uploads').selectAll().execute()).toHaveLength(2)
        await consumeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
        await expect(
          requireScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
        ).rejects.toMatchObject({ code: 'not_found' })
        expect(
          (await requireScopedUpload(f.deps, f.b.key_token, f.vault, f.grant.id, sha)).sha
        ).toBe(sha)
        await uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, bytes)
        await f.revoke(f.a.key_id)
        expect(
          (await f.t.db.selectFrom('scope_blob_uploads').select('principal_id').execute()).map(
            (row) => row.principal_id
          )
        ).toEqual([f.b.key_id])
        expect(await f.t.store.has(sha)).toBe(true)
      } finally {
        await f.close()
      }
    })
    it('does not let personal orphan GC remove another principal live entitlement', async () => {
      const f = await scopedFixture(dialect)
      try {
        const bytes = Buffer.from('pending'),
          sha = shaOf(bytes)
        await uploadScopedBlob(f.deps, f.b.key_token, f.vault, f.grant.id, sha, bytes)
        await collectUnreferenced(
          { ...f.deps, now: f.deps.now },
          new Date('2030-01-03T00:00:00.000Z')
        )
        expect(await f.t.store.has(sha)).toBe(true)
        f.setClock('2030-01-01T02:00:00.000Z')
        const config = loadConfig({
          ABELE_MASTER_KEY: 'ab'.repeat(32),
          ABELE_TOKEN_PEPPER: 'test',
          ABELE_BLOB_DIR: f.t.store.dir,
        })
        const uploads = createUploadManager({ ...f.t, config })
        await runRetention({ ...f.deps, uploads, idempotencyTtlMs: 1 })
        expect(await f.t.store.has(sha)).toBe(true)
        expect(
          (await requireScopedUpload(f.deps, f.b.key_token, f.vault, f.grant.id, sha)).sha
        ).toBe(sha)
      } finally {
        await f.close()
      }
    })
    it('refuses reader uploads and bounds payloads without exposing vault usage', async () => {
      const f = await scopedFixture(dialect)
      try {
        const reader = await f.issue('reader', 'reader'),
          bytes = Buffer.from('x')
        await expect(
          uploadScopedBlob(f.deps, reader.key_token, f.vault, f.grant.id, shaOf(bytes), bytes)
        ).rejects.toMatchObject({ code: 'forbidden' })
        await updateVaultSettings(f.deps, f.vault, { quota_bytes: 1 })
        const refusal = await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('xx'),
          Buffer.from('xx')
        ).catch((error) => error.toBody())
        expect(refusal.error).toMatchObject({ code: 'quota_exceeded', details: {} })
        await expect(
          uploadScopedBlob(
            { ...f.deps, maxScopedUploadBytes: 1 },
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('xx'),
            Buffer.from('xx')
          )
        ).rejects.toMatchObject({ code: 'too_large', details: {} })
      } finally {
        await f.close()
      }
    })
    it('binds installations to their live membership and clamps the editor ceiling without unrestricted membership', async () => {
      const f = await scopedFixture(dialect)
      try {
        const guest = await f.t.account(),
          credential = `absi_${'x'.repeat(43)}`
        await f.t.db
          .insertInto('scope_members')
          .values({
            id: 'member',
            grant_id: f.grant.id,
            account_id: guest.accountId,
            role: 'reader',
            created_at: '2030-01-01T00:00:00.000Z',
            expires_at: null,
            revoked_at: null,
          })
          .execute()
        await f.t.db
          .insertInto('scope_installations')
          .values({
            id: 'installation',
            grant_id: f.grant.id,
            member_id: 'member',
            account_id: guest.accountId,
            name: 'Guest',
            platform: 'desktop',
            token_hash: hashToken('test', credential),
            role: 'editor',
            created_at: '2030-01-01T00:00:00.000Z',
            expires_at: null,
            revoked_at: null,
            last_seen_at: null,
          })
          .execute()
        const bytes = Buffer.from('guest'),
          sha = shaOf(bytes)
        await expect(
          uploadScopedBlob(f.deps, credential, f.vault, f.grant.id, sha, bytes)
        ).rejects.toMatchObject({ code: 'forbidden' })
        await f.t.db
          .updateTable('scope_members')
          .set({ role: 'editor', authority_revision: 1 })
          .where('id', '=', 'member')
          .execute()
        await uploadScopedBlob(f.deps, credential, f.vault, f.grant.id, sha, bytes)
        expect(
          (await f.t.db.selectFrom('scope_blob_uploads').selectAll().execute())[0]
        ).toMatchObject({
          principal_kind: 'installation',
          principal_id: 'installation',
          key_id: null,
          installation_id: 'installation',
        })
        expect(
          await f.t.db
            .selectFrom('vault_members')
            .selectAll()
            .where('account_id', '=', guest.accountId)
            .execute()
        ).toEqual([])
        await f.t.db
          .updateTable('scope_members')
          .set({ revoked_at: '2030-01-01T00:00:01.000Z' })
          .where('id', '=', 'member')
          .execute()
        await expect(
          requireScopedUpload(f.deps, credential, f.vault, f.grant.id, sha)
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
    it('rechecks expiry after storing bytes and rolls back the entitlement, not another upload', async () => {
      const f = await scopedFixture(dialect)
      try {
        const original = f.t.store.put.bind(f.t.store)
        const spy = vi.spyOn(f.t.store, 'put').mockImplementation(async (...args) => {
          const result = await original(...args)
          f.setClock('2030-01-02T00:00:00.000Z')
          return result
        })
        await expect(
          uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('late'),
            Buffer.from('late')
          )
        ).rejects.toMatchObject({ code: 'unauthorized' })
        spy.mockRestore()
        expect(await f.t.db.selectFrom('scope_blob_uploads').selectAll().execute()).toEqual([])
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    })
  })
}
