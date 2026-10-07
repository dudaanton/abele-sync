import { sql, type Kysely } from 'kysely'

/** Portable static DDL; one statement per driver call also exposes crash boundaries. */
export async function scopedSql(db: Kysely<unknown>, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await sql.raw(statement).execute(db)
}
export const principalColumns = `principal_kind text not null check(principal_kind in ('key','installation')),
  principal_id text not null, key_id text, installation_id text`
export const principalConstraints = `
  foreign key(grant_id,vault_id) references scope_grants(id,vault_id),
  foreign key(key_id,grant_id) references scope_keys(id,grant_id),
  foreign key(installation_id,grant_id) references scope_installations(id,grant_id),
  check((principal_kind = 'key' and key_id = principal_id and key_id is not null and installation_id is null) or
    (principal_kind = 'installation' and installation_id = principal_id and installation_id is not null and key_id is null))`
