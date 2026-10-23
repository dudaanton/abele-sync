import type { Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import type { TokenPrincipal } from './tokens.js'

/** The same byte entitlement for commit and upload deduplication; SHA alone grants none. */
export async function ownsBlob(db: Kysely<Database>, principal: TokenPrincipal, sha: string) {
  const uploaded = await db
    .selectFrom('blob_uploads')
    .select('sha')
    .where('vault_id', '=', principal.space.id)
    .where('device_id', '=', principal.token.id)
    .where('sha', '=', sha)
    .executeTakeFirst()
  const named = uploaded
    ? uploaded
    : await db
        .selectFrom('scope_versions')
        .innerJoin('versions', 'versions.id', 'scope_versions.version_id')
        .innerJoin('scope_members', (join) =>
          join
            .onRef('scope_members.file_id', '=', 'scope_versions.file_id')
            .onRef('scope_members.scope_id', '=', 'scope_versions.scope_id')
        )
        .select('versions.id')
        .where('scope_versions.scope_id', '=', principal.scope.id)
        .where('versions.vault_id', '=', principal.space.id)
        .where('versions.blob_sha', '=', sha)
        .executeTakeFirst()

  return named !== undefined
}
