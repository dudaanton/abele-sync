import { describe, expect, it } from 'vitest'
import {
  beginScopedUpload,
  putScopedPart,
  completeScopedUpload,
} from '../../src/scoped/multipart.js'
import { requireScopedUpload } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { shaOf } from '../helpers/ops.js'
import { SCOPED_UPLOAD_LIMITS } from '../../src/scoped/uploads.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`large scoped multipart (${dialect})`, () => {
    it('resumes a >8 MiB attachment from durable sealed parts without owning any personal upload', async () => {
      const f = await scopedFixture(dialect)
      try {
        const bytes = Buffer.alloc(SCOPED_UPLOAD_LIMITS.maxBlobBytes + 123, 65),
          sha = shaOf(bytes)
        const start = await beginScopedUpload(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          sha,
          bytes.length
        )
        expect(start.part_size).toBeGreaterThan(0)
        const count = Math.ceil(bytes.length / start.part_size)
        await putScopedPart(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          start.upload_id,
          0,
          bytes.subarray(0, start.part_size)
        )
        const resumed = await beginScopedUpload(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          sha,
          bytes.length
        )
        expect(resumed).toMatchObject({ upload_id: start.upload_id, received: [0] })
        for (let i = 1; i < count; i++)
          await putScopedPart(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            start.upload_id,
            i,
            bytes.subarray(i * start.part_size, Math.min(bytes.length, (i + 1) * start.part_size))
          )
        await expect(
          completeScopedUpload(f.deps, f.b.key_token, f.vault, f.grant.id, start.upload_id)
        ).rejects.toMatchObject({ code: 'not_found' })
        expect(
          await completeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, start.upload_id)
        ).toEqual({ sha, size: bytes.length })
        expect(
          (await requireScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, sha)).size
        ).toBe(bytes.length)
        expect(await f.t.store.has(sha)).toBe(true)
        expect(await f.t.db.selectFrom('uploads').selectAll().execute()).toEqual([])
        expect(await f.t.db.selectFrom('scope_uploads').selectAll().execute()).toEqual([])
      } finally {
        await f.close()
      }
    })
    it('rejects wrong-sized and cross-principal parts, hash mismatch, and expiry without issuing entitlement', async () => {
      const f = await scopedFixture(dialect)
      try {
        const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 42),
          sha = shaOf(bytes)
        const start = await beginScopedUpload(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          sha,
          bytes.length
        )
        await expect(
          putScopedPart(
            f.deps,
            f.b.key_token,
            f.vault,
            f.grant.id,
            start.upload_id,
            0,
            bytes.subarray(0, start.part_size)
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        await expect(
          putScopedPart(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            start.upload_id,
            0,
            bytes.subarray(0, 3)
          )
        ).rejects.toMatchObject({ code: 'invalid_request' })
        for (let i = 0; i < Math.ceil(bytes.length / start.part_size); i++)
          await putScopedPart(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            start.upload_id,
            i,
            Buffer.alloc(Math.min(start.part_size, bytes.length - i * start.part_size), 43)
          )
        await expect(
          completeScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, start.upload_id)
        ).rejects.toMatchObject({ code: 'hash_mismatch' })
        await expect(
          requireScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, sha)
        ).rejects.toMatchObject({ code: 'not_found' })
        f.setClock('2030-01-02T00:00:00.000Z')
        await expect(
          putScopedPart(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            start.upload_id,
            0,
            bytes.subarray(0, start.part_size)
          )
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
  })
}
