import { describe, expect, it, vi } from 'vitest'
import { readScopedCurrent } from '../../src/scoped/content.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped current content (${dialect})`, () => {
    it('uses one authorization predicate for GET/HEAD/range/304 and always returns no-store', async () => {
      const f = await scopedFixture(dialect)
      try {
        const bytes = '0123456789',
          sha = await putBlob(f.t.app, f.device.deviceToken, bytes)
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', bytes)])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const get = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { file_id: head.file_id },
          { method: 'GET' }
        )
        expect(get.status).toBe(200)
        expect(get.body?.toString()).toBe(bytes)
        expect(get.headers['cache-control']).toBe('no-store')
        const partial = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { sha },
          { method: 'GET', range: 'bytes=2-4' }
        )
        expect(partial.status).toBe(206)
        expect(partial.body?.toString()).toBe('234')
        expect(partial.headers['content-range']).toBe('bytes 2-4/10')
        const headResponse = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { file_id: head.file_id },
          { method: 'HEAD' }
        )
        expect(headResponse.status).toBe(200)
        expect(headResponse.body).toBeUndefined()
        expect(headResponse.headers['content-length']).toBe('10')
        const unchanged = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { sha },
          { method: 'GET', ifNoneMatch: `"${sha}"` }
        )
        expect(unchanged.status).toBe(304)
        expect(unchanged.body).toBeUndefined()
        expect(unchanged.headers['cache-control']).toBe('no-store')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: head.file_id,
            base_version_id: head.version_id,
            to_path: 'Private/note.md',
          },
        ])
        for (const request of [
          { method: 'GET' as const },
          { method: 'HEAD' as const },
          { method: 'GET' as const, range: 'bytes=2-4' },
          { method: 'GET' as const, ifNoneMatch: `"${sha}"` },
        ]) {
          await expect(
            readScopedCurrent(f.deps, f.a.key_token, f.vault, f.grant.id, { sha }, request)
          ).rejects.toMatchObject({ code: 'not_found', details: {} })
        }
      } finally {
        await f.close()
      }
    })
    it('makes private/missing identities and hashes indistinguishable, including uploaded but unadmitted bytes', async () => {
      const f = await scopedFixture(dialect)
      try {
        const sha = await putBlob(f.t.app, f.device.deviceToken, 'private')
        const privateHead = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Private/note.md', 'private'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const response = (target: { sha: string } | { file_id: string }) =>
          readScopedCurrent(f.deps, f.a.key_token, f.vault, f.grant.id, target, {
            method: 'HEAD',
            ifNoneMatch: `"${sha}"`,
          }).catch((error) => error.toBody())
        expect(await response({ sha })).toEqual(await response({ sha: 'a'.repeat(64) }))
        expect(await response({ file_id: privateHead.file_id })).toEqual(
          await response({ file_id: 'unknown' })
        )
        const uploaded = await putBlob(f.t.app, f.device.deviceToken, 'upload only')
        expect(await response({ sha: uploaded })).toEqual(await response({ sha: 'a'.repeat(64) }))
      } finally {
        await f.close()
      }
    })
    it('rechecks expiry after awaited byte retrieval before returning even an authorized 304', async () => {
      const f = await scopedFixture(dialect)
      try {
        const sha = await putBlob(f.t.app, f.device.deviceToken, 'note')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const get = f.t.store.get.bind(f.t.store)
        vi.spyOn(f.t.store, 'get').mockImplementation(async (...args) => {
          const bytes = await get(...args)
          f.setClock('2030-01-02T00:00:00.000Z')
          return bytes
        })
        await expect(
          readScopedCurrent(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            { file_id: head.file_id },
            { method: 'GET', ifNoneMatch: `"${sha}"` }
          )
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    })
    it('does not return 304 for missing/corrupt bytes and refuses revoked credentials before lookup', async () => {
      const f = await scopedFixture(dialect)
      try {
        const sha = await putBlob(f.t.app, f.device.deviceToken, 'note')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', 'note')])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await f.t.store.delete(sha)
        await expect(
          readScopedCurrent(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            { file_id: head.file_id },
            { method: 'GET', ifNoneMatch: `"${sha}"` }
          )
        ).rejects.toMatchObject({ code: 'not_found', details: {} })
        await f.revoke(f.a.key_id)
        await expect(
          readScopedCurrent(f.deps, f.a.key_token, f.vault, f.grant.id, { sha }, { method: 'HEAD' })
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
  })
}
