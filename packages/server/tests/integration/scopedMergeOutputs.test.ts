import { describe, expect, it, vi } from 'vitest'
import { commitScopedModify } from '../../src/scoped/modify.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { uploadScopedBlob, requireScopedUpload } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { mergeText } from '../../src/merge/index.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { api } from '../helpers/client.js'
import { TEST_PASSWORD } from '../helpers/testApp.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped merge outputs (${dialect})`, () => {
    const setup = async (base: string, owner: string, incoming: string) => {
      const f = await scopedFixture(dialect)
      await putBlob(f.t.app, f.device.deviceToken, base)
      const head = (
        await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', base)])
      ).results[0]
      await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
      await putBlob(f.t.app, f.device.deviceToken, owner)
      const latest = (
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: head.file_id,
            base_version_id: head.version_id,
            sha: shaOf(owner),
            size: Buffer.byteLength(owner),
            mtime: 2,
          },
        ])
      ).results[0]
      await uploadScopedBlob(
        f.deps,
        f.a.key_token,
        f.vault,
        f.grant.id,
        shaOf(incoming),
        Buffer.from(incoming)
      )
      return {
        ...f,
        head,
        latest,
        input: {
          file_id: head.file_id,
          base_version_id: head.version_id,
          sha: shaOf(incoming),
          size: Buffer.byteLength(incoming),
          mtime: 3,
        },
      }
    }
    it('publishes the personal merge plus recoverable incoming version with immutable scoped/source facts and no global seq', async () => {
      const base = 'one\ntwo\nthree\n',
        owner = 'ONE\ntwo\nthree\n',
        incoming = 'one\ntwo\nTHREE\n'
      const f = await setup(base, owner, incoming)
      try {
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, f.input)
        expect(result.status).toBe('merged')
        expect(result).not.toHaveProperty('seq')
        expect((await f.deps.store.get(result.sha!)).toString()).toBe(
          mergeText(base, owner, incoming).text
        )
        const rows = await f.t.db
          .selectFrom('versions')
          .selectAll()
          .where('file_id', '=', f.head.file_id)
          .orderBy('seq')
          .execute()
        expect(rows).toHaveLength(4)
        expect(rows[2]?.blob_sha).toBe(shaOf(incoming))
        for (const row of rows.slice(2)) {
          await requireFolderVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            f.head.file_id,
            row.id
          )
          const facts = await f.t.db
            .selectFrom('version_security_sources')
            .selectAll()
            .where('version_id', '=', row.id)
            .executeTakeFirstOrThrow()
          expect(facts).toMatchObject({
            writer_facet: 'scoped',
            writer_principal_id: f.a.key_id,
            writer_grant_id: f.grant.id,
            executable: 0,
            settings: 0,
          })
          expect(JSON.parse(facts.source_version_ids)).toContain(f.head.version_id)
        }
        await expect(
          requireScopedUpload(f.deps, f.a.key_token, f.vault, f.grant.id, shaOf(incoming))
        ).rejects.toMatchObject({ code: 'not_found' })
      } finally {
        await f.close()
      }
    })
    it('keeps the head and publishes exact incoming bytes as an authorized conflict copy after base pruning', async () => {
      const current = 'current note\n',
        incoming = 'removed text\nstale note\n'
      const f = await setup('removed text\nbase note\n', current, incoming)
      try {
        await f.t.db.deleteFrom('versions').where('id', '=', f.head.version_id).execute()
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, f.input)
        expect(result).toMatchObject({
          status: 'conflict',
          version_id: f.latest.version_id,
          sha: shaOf(current),
        })
        if (result.status !== 'conflict') throw new Error('expected unknown-base conflict copy')
        expect(result).not.toHaveProperty('seq')
        expect(result.conflict_path.startsWith('Agents/')).toBe(true)
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          result.conflict_file_id,
          result.conflict_version_id
        )
        const copy = await f.t.db
          .selectFrom('versions')
          .select('blob_sha')
          .where('id', '=', result.conflict_version_id)
          .executeTakeFirstOrThrow()
        expect(copy.blob_sha).toBe(shaOf(incoming))
        expect((await f.deps.store.get(copy.blob_sha!)).toString()).toBe(incoming)
        expect(
          await f.t.db
            .selectFrom('files')
            .select('head_version_id')
            .where('id', '=', f.head.file_id)
            .executeTakeFirstOrThrow()
        ).toEqual({ head_version_id: f.latest.version_id })
        const versions = await f.t.db.selectFrom('versions').select(['op', 'blob_sha']).execute()
        expect(versions).toHaveLength(2)
        expect(versions).toContainEqual({ op: 'conflict', blob_sha: shaOf(incoming) })
        expect(versions.some((v) => v.op === 'merge')).toBe(false)
      } finally {
        await f.close()
      }
    })
    it('uses the personal invalid-YAML conflict fallback and attributes the new copy only to its originating grant', async () => {
      const titled = (title: string) => `---\ntitle: ${title}\n---\nbody\n`
      const f = await setup(titled('a'), titled('b'), titled('c'))
      try {
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, f.input)
        expect(result.status).toBe('conflict')
        if (result.status !== 'conflict') throw new Error('expected generated conflict output')
        expect(result.conflict_path.startsWith('Agents/')).toBe(true)
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          result.conflict_file_id,
          result.conflict_version_id
        )
        expect(
          await f.t.db
            .selectFrom('scope_native_files')
            .selectAll()
            .where('file_id', '=', result.conflict_file_id)
            .executeTakeFirst()
        ).toMatchObject({ grant_id: f.grant.id, creator_id: f.a.key_id })
      } finally {
        await f.close()
      }
    })
    it('retains incoming history rather than generating a copy that enters another live grant', async () => {
      const { createFolderGrant } = await import('../../src/auth/folderManagement.js')
      const titled = (title: string) => `---\ntitle: ${title}\n---\nbody\n`
      const f = await setup(titled('a'), titled('b'), titled('c'))
      try {
        await createFolderGrant(f.deps, f.owner.accountToken, f.vault, {
          label: 'overlap',
          prefix: 'Agents/',
          role: 'reader',
        })
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, f.input)
        expect(result.status).toBe('merged')
        expect(result.sha).toBe(shaOf(titled('b')))
        expect(result).not.toHaveProperty('conflict_file_id')
        const rows = await f.t.db
          .selectFrom('versions')
          .select('blob_sha')
          .where('file_id', '=', f.head.file_id)
          .execute()
        expect(rows.map((r) => r.blob_sha)).toContain(shaOf(titled('c')))
        expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
      } finally {
        await f.close()
      }
    })
    it('refuses imported binary mutation but retains a grant-native binary loser in authorized history', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'base')
        const head = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/native.png', 'base'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('loser'),
          Buffer.from('loser')
        )
        const input = {
          file_id: head.file_id,
          base_version_id: head.version_id,
          sha: shaOf('loser'),
          size: 5,
          mtime: 1,
        }
        await expect(
          commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, input)
        ).rejects.toMatchObject({ code: 'not_found' })
        await f.t.db
          .insertInto('scope_native_files')
          .values({
            vault_id: f.vault,
            grant_id: f.grant.id,
            file_id: head.file_id,
            creator_kind: 'key',
            creator_id: f.a.key_id,
            created_version_id: head.version_id,
            kind: 'attachment',
            created_at: f.deps.now().toISOString(),
          })
          .execute()
        await putBlob(f.t.app, f.device.deviceToken, 'winner')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: head.file_id,
            base_version_id: head.version_id,
            sha: shaOf('winner'),
            size: 6,
            mtime: 50,
          },
        ])
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, input)
        expect(result).toMatchObject({ status: 'merged', sha: shaOf('winner') })
        const loser = await f.t.db
          .selectFrom('versions')
          .select('id')
          .where('file_id', '=', head.file_id)
          .where('blob_sha', '=', shaOf('loser'))
          .executeTakeFirstOrThrow()
        await requireFolderVersion(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          head.file_id,
          loser.id
        )
      } finally {
        await f.close()
      }
    })
    it('keeps incoming history when the personal merged-output quota fallback cannot fit a copy', async () => {
      const base = 'shared line\n',
        owner = `${'T'.repeat(80)}\n${base}`,
        incoming = `${base}${'B'.repeat(80)}\n`
      const f = await setup(base, owner, incoming)
      try {
        await api(f.t.app, f.device.deviceToken).patch(`/v1/vaults/${f.vault}/settings`, {
          quota_bytes: 160,
          account_password: TEST_PASSWORD,
        })
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, f.input)
        expect(result).toMatchObject({ status: 'merged', sha: shaOf(owner) })
        expect(result).not.toHaveProperty('conflict_file_id')
        expect(
          (
            await f.t.db
              .selectFrom('versions')
              .select('blob_sha')
              .where('file_id', '=', f.head.file_id)
              .execute()
          ).map((row) => row.blob_sha)
        ).toContain(shaOf(incoming))
      } finally {
        await f.close()
      }
    })
    it('matches personal over-file-limit fallback and rolls all outputs back on late expiry', async () => {
      const base = 'shared line\n',
        owner = `${'T'.repeat(80)}\n${base}`,
        incoming = `${base}${'B'.repeat(80)}\n`
      const f = await setup(base, owner, incoming)
      try {
        await api(f.t.app, f.device.deviceToken).patch(`/v1/vaults/${f.vault}/settings`, {
          max_file_bytes: 100,
        })
        const result = await commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, f.input)
        expect(result.status).toBe('conflict')
        const before = await f.t.db.selectFrom('versions').select('id').execute()
        await uploadScopedBlob(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          shaOf('fresh'),
          Buffer.from('fresh')
        )
        const put = f.deps.store.put.bind(f.deps.store)
        vi.spyOn(f.deps.store, 'put').mockImplementation(async (bytes) => {
          const r = await put(bytes)
          f.setClock('2030-01-02T00:00:00.000Z')
          return r
        })
        // Force a normal merge which writes a newly generated blob, then expires before publication.
        await expect(
          commitScopedModify(f.deps, f.a.key_token, f.vault, f.grant.id, {
            ...f.input,
            sha: shaOf('fresh'),
            size: 5,
          })
        ).rejects.toMatchObject({ code: 'unauthorized' })
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(before)
      } finally {
        await f.close()
      }
    })
  })
