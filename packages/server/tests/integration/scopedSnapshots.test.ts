import { describe, expect, it } from 'vitest'
import { openFolderSnapshot, readFolderSnapshotPage } from '../../src/scoped/snapshots.js'
import { prepareFolderAdmissions, requireFolderVersion } from '../../src/scoped/admissions.js'
import { reproveFileSecurity } from '../../src/scoped/securityRepair.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'

async function prepared(dialect: 'sqlite' | 'pg') {
  const f = await scopedFixture(dialect)
  await putBlob(f.t.app, f.device.deviceToken, 'old')
  const heads = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [
      create('Agents/a.md', 'old'),
      create('Agents/b.md', 'old'),
    ])
  ).results
  await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
  return { ...f, heads }
}
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `materialized folder snapshots (${dialect})`,
    () => {
      it('returns captured old heads after an intervening edit, never mixes live rows into later pages', async () => {
        const f = await prepared(dialect)
        try {
          const first = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          expect(first.items).toHaveLength(1)
          expect(first.next_cursor).not.toBeNull()
          await putBlob(f.t.app, f.device.deviceToken, 'new')
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: f.heads[1].file_id,
              base_version_id: f.heads[1].version_id,
              sha: shaOf('new'),
              size: 3,
              mtime: 2,
            },
          ])
          const last = await readFolderSnapshotPage(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            first.next_cursor!
          )
          expect(last.items).toHaveLength(1)
          expect([...first.items, ...last.items].map((item) => item.sha)).toEqual([
            shaOf('old'),
            shaOf('old'),
          ])
          expect(last.next_cursor).toBeNull()
          expect(last.checkpoint).toEqual(first.checkpoint)
          expect(JSON.stringify(first)).not.toMatch(/head_seq|prev_path|actor_id|vault_seq/)
        } finally {
          await f.close()
        }
      })
      it('binds page cursors to exact principal, issuer and generation and rejects forged progress', async () => {
        const f = await prepared(dialect)
        try {
          const first = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          for (const [token, deps, cursor] of [
            [f.b.key_token, f.deps, first.next_cursor!],
            [
              f.a.key_token,
              { ...f.deps, endpointIdentity: 'https://other.example.test' },
              first.next_cursor!,
            ],
            [f.a.key_token, f.deps, first.next_cursor! + 'x'],
            [f.a.key_token, f.deps, '123'],
          ] as const)
            await expect(
              readFolderSnapshotPage(deps, token, f.vault, f.grant.id, cursor)
            ).rejects.toMatchObject({ code: 'scope_unavailable' })
        } finally {
          await f.close()
        }
      })
      it('invalidates incomplete views on departure and credential revoke before the next payload', async () => {
        const f = await prepared(dialect)
        try {
          const before = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'move',
              file_id: f.heads[1].file_id,
              base_version_id: f.heads[1].version_id,
              to_path: 'Private/b.md',
            },
          ])
          await expect(
            readFolderSnapshotPage(f.deps, f.a.key_token, f.vault, f.grant.id, before.next_cursor!)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          const live = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          await f.revoke(f.a.key_id)
          await expect(
            readFolderSnapshotPage(f.deps, f.a.key_token, f.vault, f.grant.id, live.cursor)
          ).rejects.toMatchObject({ code: 'unauthorized' })
        } finally {
          await f.close()
        }
      })
      it('selects the new accessible interval when security repair re-admits the same unchanged head', async () => {
        const f = await prepared(dialect)
        try {
          const head = f.heads[0]
          await f.t.db
            .deleteFrom('version_security_sources')
            .where('version_id', '=', head.version_id)
            .execute()
          await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
          await expect(
            requireFolderVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              head.file_id,
              head.version_id
            )
          ).rejects.toMatchObject({ code: 'not_found' })
          await reproveFileSecurity(f.deps, f.owner.accountToken, f.vault, head.file_id)
          expect(
            (
              await requireFolderVersion(
                f.deps,
                f.a.key_token,
                f.vault,
                f.grant.id,
                head.file_id,
                head.version_id
              )
            ).generation
          ).toBe(2)
          const snapshot = await openFolderSnapshot(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            1000
          )
          expect(snapshot.items).toHaveLength(2)
        } finally {
          await f.close()
        }
      })
      it('caps snapshots/pages and expires exact pins after five minutes without removing compact admissions', async () => {
        const f = await prepared(dialect)
        try {
          const a = await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          await expect(
            openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          ).rejects.toMatchObject({ code: 'too_large' })
          await expect(
            openFolderSnapshot(f.deps, f.b.key_token, f.vault, f.grant.id, 1001)
          ).rejects.toMatchObject({ code: 'invalid_request' })
          expect(await f.t.db.selectFrom('scope_snapshot_pins').selectAll().execute()).toHaveLength(
            4
          )
          f.setClock('2030-01-01T00:05:00.000Z')
          await expect(
            readFolderSnapshotPage(f.deps, f.a.key_token, f.vault, f.grant.id, a.next_cursor!)
          ).rejects.toMatchObject({ code: 'scope_unavailable' })
          await openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id, 1)
          expect(await f.t.db.selectFrom('scope_snapshot_pins').selectAll().execute()).toHaveLength(
            2
          )
          expect(
            await f.t.db.selectFrom('scope_version_admissions').selectAll().execute()
          ).toHaveLength(2)
        } finally {
          await f.close()
        }
      })
    }
  )
}
