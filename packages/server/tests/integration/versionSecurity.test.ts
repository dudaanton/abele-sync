import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as YAML from 'yaml'
vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>()
  return { ...actual, parseDocument: vi.fn(actual.parseDocument), parse: vi.fn(actual.parse) }
})
import { folderEligibility } from '../../src/scoped/folderSecurity.js'
import { reproveFileSecurity } from '../../src/scoped/securityRepair.js'
import { TEST_TOKEN_PEPPER } from '../helpers/testApp.js'
import { updateVaultSettings } from '../../src/vault/vaults.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`immutable security facts (${dialect})`, () => {
    let t: TestApp,
      token: string,
      vault: string,
      account: string,
      device: string,
      ownerToken: string
    const facts = (id: string) =>
      t.db
        .selectFrom('version_security_sources')
        .selectAll()
        .where('version_id', '=', id)
        .executeTakeFirstOrThrow()
    const write = async (path: string, text = 'content') => {
      await putBlob(t.app, token, text)
      return (await commit(t.app, token, vault, [create(path, text)])).results[0]
    }
    const move = async (head: any, path: string) =>
      (
        await commit(t.app, token, vault, [
          { op: 'move', file_id: head.file_id, base_version_id: head.version_id, to_path: path },
        ])
      ).results[0]
    beforeEach(async () => {
      vi.clearAllMocks()
      t = await buildTestApp({ dialect, configurationDirectories: ['Config'] })
      const owner = await t.account()
      account = owner.accountId
      ownerToken = owner.accountToken
      vault = (await t.vault(owner.accountToken)).vaultId
      const d = await t.device(owner.accountToken, vault)
      token = d.deviceToken
      device = d.deviceId
    })
    afterEach(async () => {
      vi.restoreAllMocks()
      await t.close()
    })
    it('records writer/security facts for no-grant/folder-only commits with zero scope body parsing', async () => {
      const parse = vi.mocked(YAML.parseDocument)
      const head = await write('Agents/note.md', '---\ngroups: [[[broken\n---\n![[Private.png]]')
      expect(await facts(head.version_id)).toMatchObject({
        writer_facet: 'device',
        writer_principal_id: device,
        writer_account_id: account,
        executable: 0,
        settings: 0,
        source_version_ids: '[]',
      })
      expect(parse).not.toHaveBeenCalled()
      expect(vi.mocked(YAML.parse)).not.toHaveBeenCalled()
      await sql`insert into scope_grants (id,vault_id,owner_account_id,label,selector_kind,folder_prefix,role,created_at)
        values ('folder',${vault},${account},'Agents','folder','Agents/','editor','2030-01-01T00:00:00.000Z')`.execute(
        t.db
      )
      // Raw fixture grant creation must initialize the durable grant-local feed,
      // just as the management service does; parser assertions remain unchanged.
      await t.db
        .insertInto('scope_feed_state')
        .values({ grant_id: 'folder', updated_at: '2030-01-01T00:00:00.000Z' })
        .execute()
      const next = await write('Agents/other.md', '---\ngroups: [[Books]]\n---\n![[private.png]]')
      expect((await facts(next.version_id)).executable).toBe(0)
      expect(parse).not.toHaveBeenCalled()
    })
    it('keeps executable provenance after .js becomes .png, independently of retention class', async () => {
      const original = await write('Scripts/evil.js', 'evil()'),
        moved = await move(original, 'Agents/image.png')
      const security = await facts(moved.version_id)
      expect(security).toMatchObject({ executable: 1, settings: 0 })
      expect(
        folderEligibility('Agents/', { path: moved.path, kind: 'attachment', security }).eligible
      ).toBe(false)
      expect(
        (
          await t.db
            .selectFrom('versions')
            .select('retention_class')
            .where('id', '=', moved.version_id)
            .executeTakeFirstOrThrow()
        ).retention_class
      ).toBe('attachments')
    })
    for (const config of ['.obsidian/app.json', 'Config/plugins/main.json']) {
      it(`keeps settings provenance across move/restore from ${config}`, async () => {
        const original = await write(config, 'private settings'),
          moved = await move(original, 'Agents/settings.png')
        expect((await facts(moved.version_id)).settings).toBe(1)
        const restored = (
          await api(t.app, token).post(`/v1/vaults/${vault}/files/${original.file_id}/restore`, {
            version_id: original.version_id,
          })
        ).body
        expect((await facts(restored.version_id)).settings).toBe(1)
      })
    }
    it('cannot reveal formerly renamed configuration when an additional root is registered, even after pruning', async () => {
      const source = await write('OtherConfig/private.json', 'private'),
        moved = await move(source, 'Agents/image.png')
      await t.db.deleteFrom('versions').where('id', '=', source.version_id).execute()
      expect(
        folderEligibility(
          'Agents/',
          { path: moved.path, kind: 'attachment', security: await facts(moved.version_id) },
          { configurationDirectories: ['OtherConfig'] }
        ).reason
      ).toBe('settings')
    })
    it('holds a missing historical restore fact locally while a newly proven sibling remains eligible', async () => {
      const old = await write('Agents/legacy.md', 'legacy'),
        normal = await write('Agents/new.md', 'new')
      await t.db
        .deleteFrom('version_security_sources')
        .where('version_id', '=', old.version_id)
        .execute()
      await putBlob(t.app, token, 'replacement')
      const changed = (
        await commit(t.app, token, vault, [
          {
            op: 'modify',
            file_id: old.file_id,
            base_version_id: old.version_id,
            sha: shaOf('replacement'),
            size: 11,
            mtime: 1,
          },
        ])
      ).results[0]
      const restore = (
        await api(t.app, token).post(`/v1/vaults/${vault}/files/${old.file_id}/restore`, {
          version_id: old.version_id,
        })
      ).body
      const unknown = await facts(restore.version_id)
      expect(JSON.parse(unknown.source_version_ids)).toContain(old.version_id)
      expect(changed.status).toBe('applied')
      expect(unknown).toMatchObject({ executable: null, settings: null })
      expect(
        folderEligibility('Agents/', { path: 'Agents/legacy.md', kind: 'note', security: unknown })
          .reason
      ).toBe('security_unknown')
      expect(
        folderEligibility('Agents/', {
          path: 'Agents/new.md',
          kind: 'note',
          security: await facts(normal.version_id),
        }).eligible
      ).toBe(true)
    })
    it('reproves a bounded intact legacy chain without upgrading its unknown writer origin', async () => {
      const old = await write('Agents/legacy.md', 'legacy')
      await t.db
        .deleteFrom('version_security_sources')
        .where('version_id', '=', old.version_id)
        .execute()
      await putBlob(t.app, token, 'edited legacy')
      const head = (
        await commit(t.app, token, vault, [
          {
            op: 'modify',
            file_id: old.file_id,
            base_version_id: old.version_id,
            sha: shaOf('edited legacy'),
            size: 13,
            mtime: 1,
          },
        ])
      ).results[0]
      expect((await facts(head.version_id)).executable).toBeNull()
      const result = await reproveFileSecurity(
        {
          db: t.db,
          dialect,
          pepper: TEST_TOKEN_PEPPER,
          accountTokenTtlMs: 3600000,
          configurationDirectories: ['Config'],
        },
        ownerToken,
        vault,
        old.file_id
      )
      expect(result.state).toBe('known')
      expect((await facts(head.version_id)).executable).toBe(0)
      const proof = await facts(old.version_id)
      expect(proof).toMatchObject({
        writer_facet: 'unknown',
        writer_principal_id: null,
        executable: 0,
        settings: 0,
      })
      expect(
        folderEligibility('Agents/', { path: 'Agents/legacy.md', kind: 'note', security: proof })
          .eligible
      ).toBe(true)
    })
    it('does not guess a legacy restore source or block a separately proven file', async () => {
      const old = await write('Agents/unknown.md', 'old'),
        sibling = await write('Agents/healthy.md', 'healthy')
      await t.db
        .updateTable('versions')
        .set({ op: 'restore' })
        .where('id', '=', old.version_id)
        .execute()
      await t.db
        .deleteFrom('version_security_sources')
        .where('version_id', '=', old.version_id)
        .execute()
      const result = await reproveFileSecurity(
        { db: t.db, dialect, pepper: TEST_TOKEN_PEPPER, accountTokenTtlMs: 3600000 },
        ownerToken,
        vault,
        old.file_id
      )
      expect(result.state).toBe('hold')
      expect(
        (
          await reproveFileSecurity(
            { db: t.db, dialect, pepper: TEST_TOKEN_PEPPER, accountTokenTtlMs: 3600000 },
            ownerToken,
            vault,
            old.file_id
          )
        ).state
      ).toBe('hold')
      expect((await facts(old.version_id)).executable).toBeNull()
      expect(
        folderEligibility('Agents/', {
          path: 'Agents/healthy.md',
          kind: 'note',
          security: await facts(sibling.version_id),
        }).eligible
      ).toBe(true)
    })
    it('keeps all binary-loser and normal text-merge outputs security-fenced', async () => {
      for (const [path, baseText, headText, incomingText] of [
        ['Agents/data.bin', 'base', 'head', 'incoming'],
        ['Agents/text.md', 'one\ntwo\nthree\n', 'ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n'],
      ]) {
        const base = await write(path!, baseText!)
        await putBlob(t.app, token, headText!)
        const head = (
          await commit(t.app, token, vault, [
            {
              op: 'modify',
              file_id: base.file_id,
              base_version_id: base.version_id,
              sha: shaOf(headText!),
              size: Buffer.byteLength(headText!),
              mtime: 20,
            },
          ])
        ).results[0]
        await putBlob(t.app, token, incomingText!)
        const merged = (
          await commit(t.app, token, vault, [
            {
              op: 'modify',
              file_id: base.file_id,
              base_version_id: base.version_id,
              sha: shaOf(incomingText!),
              size: Buffer.byteLength(incomingText!),
              mtime: 2,
            },
          ])
        ).results[0]
        expect(merged.status).toBe('merged')
        const outputs = await t.db
          .selectFrom('versions')
          .select('id')
          .where('file_id', '=', base.file_id)
          .execute()
        expect(outputs).toHaveLength(4)
        for (const output of outputs)
          expect(await facts(output.id)).toMatchObject({ executable: 0, settings: 0 })
        expect(JSON.parse((await facts(merged.version_id)).source_version_ids)).toContain(
          head.version_id
        )
      }
    })
    it('bounds file-local reproving and holds a pruned ancestor instead of manufacturing provenance', async () => {
      const base = await write('Agents/deep.md', 'base')
      await t.db
        .deleteFrom('version_security_sources')
        .where('file_id', '=', base.file_id)
        .execute()
      await t.db
        .insertInto('versions')
        .values(
          Array.from({ length: 129 }, (_, i) => ({
            id: `deep-${i}`,
            file_id: base.file_id,
            vault_id: vault,
            seq: i + 2,
            no: i + 2,
            op: 'modify' as const,
            path: 'Agents/deep.md',
            prev_path: null,
            blob_sha: null,
            size: 0,
            mtime: 1,
            actor_kind: 'device' as const,
            actor_id: device,
            actor_name: 'Synthetic',
            created_at: '2030-01-01T00:00:00.000Z',
            prev_version_id: i === 0 ? base.version_id : `deep-${i - 1}`,
            merge: null,
            retention_class: 'notes' as const,
          }))
        )
        .execute()
      await t.db
        .updateTable('files')
        .set({ head_version_id: 'deep-128' })
        .where('id', '=', base.file_id)
        .execute()
      const proof = await reproveFileSecurity(
        { db: t.db, dialect, pepper: TEST_TOKEN_PEPPER, accountTokenTtlMs: 3600000 },
        ownerToken,
        vault,
        base.file_id
      )
      expect(proof).toMatchObject({ state: 'hold', examined: 128 })
      expect((await facts('deep-128')).executable).toBeNull()
    })
    it('classifies every auxiliary/merged/conflict output and retains its source IDs without old payload FKs', async () => {
      const original = await write('Scripts/old.js', 'before'),
        moved = await move(original, 'Agents/note.md')
      await updateVaultSettings({ ...t, dialect }, vault, { conflict: 'conflict-file' })
      await putBlob(t.app, token, 'new incoming')
      const response = (
        await commit(t.app, token, vault, [create('Agents/note.md', 'new incoming')])
      ).results[0]
      expect(response.status).toBe('conflict')
      const copy = await facts(response.conflict_version_id)
      expect(copy.executable).toBe(1)
      expect(JSON.parse(copy.source_version_ids)).toContain(moved.version_id)
      const rows = await t.db.selectFrom('versions').select('id').execute()
      for (const { id } of rows) await expect(facts(id)).resolves.toBeDefined()
      await t.db.deleteFrom('versions').where('id', '=', original.version_id).execute()
      expect((await facts(original.version_id)).executable).toBe(1)
    })
  })
}
