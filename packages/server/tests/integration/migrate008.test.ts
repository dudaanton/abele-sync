import { sql, type KyselyPlugin } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp } from '../helpers/testApp.js'
import {
  authority,
  at,
  hardening,
  personalRows,
  populated007,
  seedAuthority,
  until,
} from '../helpers/scopedMigration.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`008 scoped authority (${dialect})`, () => {
    it('preserves populated 007 devices, uploads, completion claims, receipts and retention classes exactly', async () => {
      const t = await populated007(dialect)
      try {
        const before = await personalRows(t.db)
        await runMigrations(t.db, t.schema, authority)
        expect(await personalRows(t.db)).toEqual(before)
        expect((await sql`select issued_at from account_tokens`.execute(t.db)).rows).toEqual([
          { issued_at: null },
        ])
        expect((await sql`select * from version_security_sources`.execute(t.db)).rows).toEqual([])
        expect((await sql`select * from account_authority`.execute(t.db)).rows).toEqual([
          { account_id: 'owner', revision: 0 },
        ])
        await runMigrations(t.db, t.schema, authority)
        expect(await personalRows(t.db)).toEqual(before)
      } finally {
        await t.close()
      }
    })
    it('fences one selector, owner identity, roles, independent same-SHA entitlements and compact receipt identity', async () => {
      const t = await populated007(dialect)
      try {
        await runMigrations(t.db, t.schema, authority)
        await seedAuthority(t.db)
        await expect(
          sql`insert into scope_grants (id,vault_id,owner_account_id,label,selector_kind,folder_prefix,root_file_id,role,created_at)
          values ('bad','vault','owner','bad','folder','Agents/','file','editor',${at})`.execute(
            t.db
          )
        ).rejects.toThrow()
        await expect(
          sql`insert into scope_keys (id,grant_id,owner_account_id,name,token_hash,role,created_at,expires_at)
          values ('bad','grant','not-owner','bad','bad','editor',${at},${until})`.execute(t.db)
        ).rejects.toThrow()
        await sql`insert into scope_keys (id,grant_id,owner_account_id,name,token_hash,role,created_at,expires_at)
          values ('key2','grant','owner','Agent2','synthetic-key2','editor',${at},${until})`.execute(
          t.db
        )
        for (const id of ['key', 'key2'])
          await sql`insert into scope_blob_uploads
          (vault_id,sha,principal_kind,principal_id,key_id,grant_id,size,created_at)
          values ('vault',${'a'.repeat(64)},'key',${id},${id},'grant',1,${at})`.execute(t.db)
        await sql`delete from scope_blob_uploads where principal_id = 'key'`.execute(t.db)
        expect((await sql`select principal_id from scope_blob_uploads`.execute(t.db)).rows).toEqual(
          [{ principal_id: 'key2' }]
        )
        await sql`insert into scope_receipts (vault_id,grant_id,principal_kind,principal_id,key_id,endpoint_identity,request_id,request_hash,outcome_id,status,response,created_at,payload_expires_at)
          values ('vault','grant','key','key','key','issuer/grant/commit','request','hash','outcome',200,'{}',${at},${until})`.execute(
          t.db
        )
        await sql`update scope_receipts set response = null where request_id = 'request'`.execute(
          t.db
        )
        expect((await sql`select outcome_id from scope_receipts`.execute(t.db)).rows).toEqual([
          { outcome_id: 'outcome' },
        ])
        expect((await sql`select * from vault_members`.execute(t.db)).rows).toEqual([])
        await expect(runMigrations(t.db, t.schema, hardening)).rejects.toThrow(/downgrade/)
      } finally {
        await t.close()
      }
    })
    it('records issuance time only for newly password-authenticated sessions', async () => {
      const t = await buildTestApp({ dialect })
      try {
        await t.account()
        const row = (
          await sql<{ issued_at: string | null }>`select issued_at from account_tokens`.execute(
            t.db
          )
        ).rows[0]!
        expect(row.issued_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      } finally {
        await t.close()
      }
    })
    it('rolls back DDL and its journal together when journal insertion fails, then retries', async () => {
      const t = await populated007(dialect)
      const failJournal: KyselyPlugin = {
        transformQuery({ node }) {
          if (node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('kysely_migration'))
            throw new Error('journal cut')
          return node
        },
        async transformResult({ result }) {
          return result
        },
      }
      try {
        await expect(
          runMigrations(t.db.withPlugin(failJournal), t.schema, authority)
        ).rejects.toThrow()
        await expect(sql`select * from scope_grants`.execute(t.db)).rejects.toThrow()
        expect(
          (await sql`select name from kysely_migration order by name`.execute(t.db)).rows.at(-1)
        ).toEqual({ name: hardening })
        await runMigrations(t.db, t.schema, authority)
      } finally {
        await t.close()
      }
    })
  })
}
