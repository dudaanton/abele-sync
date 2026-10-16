import { randomUUID } from 'node:crypto'
import { AbeleError, validatePath, type Actor } from '@abele/sync-protocol'
import { commitChosen, type CommitDeps } from '../oplog/commit.js'
import type { Ctx } from '../oplog/commitCtx.js'
import { runDirectory } from './directories.js'
import { type AccessDeps } from './tokens.js'
import { recordFileVersion } from './visibility.js'
import { indexVersion, refreshGroups } from './groups/graph.js'

/** Selection, tombstones, revocation and audit share the engine lock and transaction. */
export async function deleteFolder(
  deps: CommitDeps & AccessDeps,
  spaceId: string,
  path: string,
  actor: Actor
) {
  validatePath(path)
  const revoked: string[] = []
  let files = 0
  const result = await commitChosen(
    {
      ...deps,
      before: async (ctx) => {
        // SQLite may replay the transaction after a busy snapshot rolls back.
        revoked.length = 0
        files = 0
        const space = await ctx.trx
          .selectFrom('spaces')
          .select('deleted_at')
          .where('id', '=', spaceId)
          .executeTakeFirstOrThrow()
        if (space.deleted_at) throw new AbeleError('forbidden', 'vault is deleted')
      },
      runDirectory: async (ctx, op) => {
        const start = (
          await ctx.trx
            .selectFrom('vault_seq')
            .select('head_seq')
            .where('vault_id', '=', spaceId)
            .executeTakeFirstOrThrow()
        ).head_seq
        const dirs = await ctx.trx
          .selectFrom('directories')
          .selectAll()
          .where('space_id', '=', spaceId)
          .where('deleted_at', 'is', null)
          .execute()
        const ids = new Set(
          dirs.filter((d) => d.path === path || d.path.startsWith(path + '/')).map((d) => d.id)
        )
        const answer = await runDirectory(ctx, deps, op)
        const versions = await recordDeletedVersions(ctx, deps, start)
        files = versions.length
        const deletedFiles = new Set(versions.map((v) => v.file_id))
        const scopes = await ctx.trx
          .selectFrom('access_scopes')
          .selectAll()
          .where('space_id', '=', spaceId)
          .execute()
        const dead = new Set(
          scopes
            .filter((s) =>
              s.kind === 'folder' ? ids.has(s.target_id) : deletedFiles.has(s.target_id)
            )
            .map((s) => s.id)
        )
        let changed = true
        while (changed) {
          changed = false
          for (const s of scopes)
            if (s.boundary_scope_id && dead.has(s.boundary_scope_id) && !dead.has(s.id)) {
              dead.add(s.id)
              changed = true
            }
        }
        for (const scope of dead) {
          const tokens = await ctx.trx
            .updateTable('access_tokens')
            .set({ revoked_at: ctx.at.toISOString(), scope_deleted_at: ctx.at.toISOString() })
            .where('scope_id', '=', scope)
            .where('revoked_at', 'is', null)
            .returning('id')
            .execute()
          revoked.push(...tokens.map((t) => t.id))
        }
        await ctx.trx
          .insertInto('audit')
          .values({
            id: randomUUID(),
            vault_id: spaceId,
            actor_kind: actor.kind,
            actor_id: actor.id,
            action: 'folder.delete',
            path,
            result: 'applied',
            at: ctx.at.toISOString(),
            details: JSON.stringify({ files, revoked_tokens: revoked }),
          })
          .execute()
        return answer
      },
    },
    spaceId,
    actor,
    async (db) => {
      const dir = await db
        .selectFrom('directories')
        .selectAll()
        .where('space_id', '=', spaceId)
        .where('path', '=', path)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
      if (!dir || dir.path === '/')
        throw new AbeleError('not_found', 'no mutable folder at that path')
      return [{ op: 'delete_directory', file_id: dir.id, base_version_id: dir.version_id }]
    }
  )
  for (const id of revoked) deps.hub.hangUp(id, 4004)
  return { cursor: result.head_seq, files, revoked_tokens: revoked }
}

export async function recordDeletedVersions(
  ctx: Ctx,
  deps: CommitDeps & AccessDeps,
  start: number
) {
  const versions = await ctx.trx
    .selectFrom('versions')
    .selectAll()
    .where('vault_id', '=', ctx.vaultId)
    .where('seq', '>', start)
    .execute()
  const affected = new Set<string>()
  for (const v of versions) {
    const kind = (
      await ctx.trx
        .selectFrom('files')
        .select('kind')
        .where('id', '=', v.file_id)
        .executeTakeFirstOrThrow()
    ).kind
    const access = { ...deps, db: ctx.trx }
    for (const id of await indexVersion(access, v, kind)) affected.add(id)
    await recordFileVersion(access, v, kind)
  }
  await refreshGroups(
    { ...deps, db: ctx.trx },
    ctx.vaultId,
    affected,
    ctx.at.toISOString(),
    versions,
    true
  )
  return versions
}
