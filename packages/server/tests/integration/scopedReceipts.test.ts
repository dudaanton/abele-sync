import { describe, expect, it, vi } from 'vitest'
import { commitScoped } from '../../src/scoped/commits.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, shaOf } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped durable receipts (${dialect})`, () => {
    it('replays a lost create reply exactly once and keeps outcome identity after payload expiry', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('new'),
          Buffer.from('new')
        )
        const ops = [create('Agents/new.md', 'new')]
        const result = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'request-1',
          ops
        )
        expect(
          await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'request-1', ops)
        ).toEqual(result)
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
        await expect(
          commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'request-1', [
            create('Agents/other.md', 'new'),
          ])
        ).rejects.toMatchObject({ code: 'idempotency_mismatch' })
        await f.t.db.updateTable('scope_receipts').set({ response: null }).execute()
        const compact = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'request-1',
          ops
        )
        expect(compact).toMatchObject({
          outcome_id: result.outcome_id,
          acknowledged: true,
          results: [],
        })
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
      } finally {
        await f.close()
      }
    })
    it('consumes an upload once for an atomic same-SHA create unit and replays the entire unit', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('same'),
          Buffer.from('same')
        )
        const ops = [create('Agents/one.md', 'same'), create('Agents/two.md', 'same')]
        const first = await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'unit', ops)
        expect(first.results).toHaveLength(2)
        expect(await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'unit', ops)).toEqual(
          first
        )
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(2)
        expect(await f.t.db.selectFrom('scope_blob_uploads').select('sha').execute()).toHaveLength(
          0
        )
      } finally {
        await f.close()
      }
    })
    it('replays a lost merged reply without adding another auxiliary version or merge', async () => {
      const f = await scopedFixture(dialect)
      try {
        const { putBlob } = await import('../helpers/ops.js')
        const base = 'a\nb\nc\n',
          owner = 'A\nb\nc\n',
          incoming = 'a\nb\nC\n'
        await putBlob(f.t.app, f.device.deviceToken, base)
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/merge.md', base)])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await putBlob(f.t.app, f.device.deviceToken, owner)
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: head.file_id,
            base_version_id: head.version_id,
            sha: shaOf(owner),
            size: owner.length,
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
        const ops = [
          {
            op: 'modify',
            file_id: head.file_id,
            base_version_id: head.version_id,
            sha: shaOf(incoming),
            size: incoming.length,
            mtime: 3,
          },
        ]
        const first = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'merge-retry',
          ops
        )
        expect(first.results[0]?.status).toBe('merged')
        expect(
          await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'merge-retry', ops)
        ).toEqual(first)
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(4)
      } finally {
        await f.close()
      }
    })
    it('never replays old path/SHA after departure and refuses revoked principal retries', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('secret'),
          Buffer.from('secret')
        )
        const ops = [create('Agents/secret.md', 'secret')]
        const first = await commitScoped(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            'request-2',
            ops
          ),
          file = first.results[0]!
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'Private/secret.md',
          },
        ])
        const replay = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'request-2',
          ops
        )
        expect(replay).toMatchObject({
          outcome_id: first.outcome_id,
          acknowledged: true,
          results: [],
        })
        expect(JSON.stringify(replay)).not.toMatch(/Agents|Private|secret/)
        await f.revoke(f.a.key_id)
        await expect(
          commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'request-2', ops)
        ).rejects.toMatchObject({ code: 'unauthorized' })
      } finally {
        await f.close()
      }
    })
    it('binds outcomes to the exact principal/issuer and rolls receipt plus outputs back on late expiry', async () => {
      const f = await scopedFixture(dialect)
      try {
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('new'),
          Buffer.from('new')
        )
        const ops = [create('Agents/new.md', 'new')]
        const first = await commitScoped(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'request-3',
          ops
        )
        await expect(
          commitScoped(f.deps, f.b.key_token, f.vault, f.grant.id, 'request-3', ops)
        ).rejects.toMatchObject({ code: 'not_found' })
        await expect(
          commitScoped(
            { ...f.deps, endpointIdentity: 'https://other.example.test' },
            f.a.key_token,
            f.vault,
            f.grant.id,
            'request-3',
            ops
          )
        ).rejects.toMatchObject({ code: 'not_found' })
        expect(await f.t.db.selectFrom('scope_receipts').select('outcome_id').execute()).toEqual([
          { outcome_id: first.outcome_id },
        ])
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('late'),
          Buffer.from('late')
        )
        const size = f.t.store.size.bind(f.t.store)
        vi.spyOn(f.t.store, 'size').mockImplementation(async (sha) => {
          const value = await size(sha)
          f.setClock('2030-01-02T00:00:00.000Z')
          return value
        })
        await expect(
          commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'late', [
            create('Agents/late.md', 'late'),
          ])
        ).rejects.toMatchObject({ code: 'unauthorized' })
        expect(await f.t.db.selectFrom('scope_receipts').select('request_id').execute()).toEqual([
          { request_id: 'request-3' },
        ])
        expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    })
  })
