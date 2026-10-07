import { describe, expect, it } from 'vitest'
import { commitScopedOperations } from '../../src/scoped/operations.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { uploadScopedBlob } from '../../src/scoped/uploads.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createFolderGrant } from '../../src/auth/folderManagement.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `scoped native create/move (${dialect})`,
    () => {
      it('creates a new identity from exact own bytes, preserving native attribution and exact vault path', async () => {
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
          const result = await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
            create('Agents/new.md', 'new'),
          ])
          expect(result.results[0]).toMatchObject({
            status: 'applied',
            path: 'Agents/new.md',
            sha: shaOf('new'),
          })
          expect(JSON.stringify(result)).not.toMatch(/"seq"|head_seq|actor_name/)
          const native = await f.t.db
            .selectFrom('scope_native_files')
            .selectAll()
            .executeTakeFirstOrThrow()
          expect(native).toMatchObject({
            file_id: result.results[0]!.file_id,
            creator_id: f.a.key_id,
            grant_id: f.grant.id,
          })
          expect(
            (await f.t.db.selectFrom('scope_current_members').selectAll().execute())[0]?.file_id
          ).toBe(native.file_id)
        } finally {
          await f.close()
        }
      })
      it('does not adopt or disclose an occupied identity even for identical bytes and never creates across another grant', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'same')
          const hidden = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [
              create('Private/hidden.md', 'same'),
              create('Agents/occupied.md', 'same'),
            ])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('same'),
            Buffer.from('same')
          )
          const ask = (path: string) =>
            commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              create(path, 'same'),
            ]).catch((error) => error.toBody())
          const unavailable = await ask('Private/absent.md')
          expect(await ask('Private/hidden.md')).toEqual(unavailable)
          expect(await ask('Agents/occupied.md')).toEqual(unavailable)
          expect(JSON.stringify(unavailable)).not.toContain(hidden.file_id)
          await createFolderGrant(f.deps, f.owner.accountToken, f.vault, {
            label: 'other',
            prefix: 'Agents/sub/',
            role: 'editor',
          })
          expect(await ask('Agents/sub/new.md')).toEqual(unavailable)
          expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(2)
        } finally {
          await f.close()
        }
      })
      it('publishes a move+modify atomically and rolls both back when a later destination is forbidden', async () => {
        const f = await scopedFixture(dialect)
        try {
          await putBlob(f.t.app, f.device.deviceToken, 'old')
          const first = (
            await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/old.md', 'old')])
          ).results[0]
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await uploadScopedBlob(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            shaOf('new'),
            Buffer.from('new')
          )
          const move = {
            op: 'move',
            file_id: first.file_id,
            base_version_id: first.version_id,
            to_path: 'Agents/new.md',
          }
          const modify = {
            op: 'modify',
            file_id: first.file_id,
            base_version_id: first.version_id,
            sha: shaOf('new'),
            size: 3,
            mtime: 3,
          }
          const result = await commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
            move,
            modify,
          ])
          expect(result.results).toHaveLength(2)
          expect(result.results[1]).toMatchObject({
            status: 'applied',
            path: 'Agents/new.md',
            sha: shaOf('new'),
          })
          const before = await f.t.db.selectFrom('versions').select('id').execute()
          const head = result.results[1]!
          await expect(
            commitScopedOperations(f.deps, f.a.key_token, f.vault, f.grant.id, [
              { ...move, base_version_id: head.version_id, to_path: 'Agents/next.md' },
              { ...move, base_version_id: head.version_id, to_path: 'Private/escape.md' },
            ])
          ).rejects.toMatchObject({ code: 'not_found' })
          expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(before)
          expect(
            (
              await f.t.db
                .selectFrom('files')
                .select('path')
                .where('id', '=', first.file_id)
                .executeTakeFirstOrThrow()
            ).path
          ).toBe('Agents/new.md')
        } finally {
          await f.close()
        }
      })
    }
  )
