import { sql } from 'kysely'
import type { Dialect } from '../../src/db/connect.js'
import { runMigrations } from '../../src/db/migrate.js'
import { tempDb } from './tempDb.js'

export const at = '2030-01-01T00:00:00.000Z'
export const until = '2030-01-01T00:05:00.000Z'
export const wide = 2 ** 32 + 1
export const hardening = '007_version_retention_class'
export const authority = '008_scoped_authority'
export const views = '009_scoped_views'

export async function populated007(dialect: Dialect) {
  const t = await tempDb(dialect, (db, schema) => runMigrations(db, schema, hardening))
  try {
    await sql`insert into accounts values ('owner', 'owner@example.test', 'unused-hash', ${at}, null)`.execute(
      t.db
    )
    await sql`insert into account_tokens values ('session', 'owner', ${until})`.execute(t.db)
    await sql`insert into vaults values ('vault', 'owner', 'Sample', '{}', ${at})`.execute(t.db)
    await sql`insert into vault_seq (vault_id,head_seq) values ('vault', ${wide})`.execute(t.db)
    await sql`insert into devices (id,account_id,vault_id,name,platform,token_hash,selective,created_at)
      values ('device','owner','vault','Sample','desktop','unused-token-hash','{}',${at})`.execute(
      t.db
    )
    await sql`insert into files values ('file','vault','Agents/sample.md','agents/sample.md','note','version',null)`.execute(
      t.db
    )
    await sql`insert into versions (id,file_id,vault_id,seq,no,op,path,blob_sha,size,mtime,
      actor_kind,actor_id,actor_name,created_at,retention_class)
      values ('version','file','vault',${wide},1,'create','Agents/sample.md',null,${wide},${wide},'device','device','Sample',${at},'notes')`.execute(
      t.db
    )
    await sql`insert into uploads (id,sha,size,part_size,parts_received,created_at,vault_id,device_id,completing_at)
      values ('upload',${'a'.repeat(64)},${wide},64,'[0,1]',${at},'vault','device',${at})`.execute(
      t.db
    )
    await sql`insert into uploads (id,sha,size,part_size,parts_received,created_at)
      values ('orphan',${'b'.repeat(64)},${wide},64,'[]',${at})`.execute(t.db)
    await sql`insert into blob_uploads values ('vault',${'a'.repeat(64)},'device',${wide},${at})`.execute(
      t.db
    )
    await sql`insert into idempotency values ('device','request','hash',200,'{"kept":"exact"}',${at})`.execute(
      t.db
    )
    return t
  } catch (error) {
    await t.close()
    throw error
  }
}

export async function personalRows(db: Awaited<ReturnType<typeof populated007>>['db']) {
  const rows: Record<string, unknown[]> = {}
  for (const table of [
    'devices',
    'uploads',
    'blob_uploads',
    'idempotency',
    'versions',
    'files',
    'vault_members',
  ]) {
    rows[table] = (await sql`select * from ${sql.table(table)}`.execute(db)).rows
  }
  return rows
}

export async function seedAuthority(db: Awaited<ReturnType<typeof populated007>>['db']) {
  await sql`insert into scope_grants (id,vault_id,owner_account_id,label,selector_kind,folder_prefix,role,created_at)
    values ('grant','vault','owner','Agents','folder','Agents/','editor',${at})`.execute(db)
  await sql`insert into scope_keys (id,grant_id,owner_account_id,name,token_hash,role,created_at,expires_at)
    values ('key','grant','owner','Agent','synthetic-key-hash','editor',${at},${until})`.execute(db)
}
