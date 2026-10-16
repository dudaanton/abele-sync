import { addDaily } from '../history/activity.js'
import { createHash } from 'node:crypto'
import {
  AbeleError,
  caseKey,
  type CommitOpResult,
  type V2CommitOp,
  type V2CommitResponse,
} from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import type { Ctx } from '../oplog/commitCtx.js'
import { commitChosen, type CommitDeps } from '../oplog/commit.js'
import { headSeqOf } from '../oplog/changes.js'
import { Replay, type KeyedRun } from '../oplog/keyed.js'
import { authenticateToken, requireWrite, type AccessDeps, type TokenPrincipal } from './tokens.js'
import {
  activeScope,
  covers,
  member,
  versionVisible,
  recordFileVersion,
  groupPathAllowed,
} from './visibility.js'
import { indexVersion, qualifies, refreshGroups, ancestors } from './groups/graph.js'
import {
  ensureParents,
  runDirectory,
  validateDirectoryOp,
  validateDestination,
} from './directories.js'

export async function authorizeOp(
  ctx: Ctx,
  deps: CommitDeps & AccessDeps,
  principal: TokenPrincipal,
  op: V2CommitOp,
  publication = false
) {
  requireWrite(principal)
  await activeScope({ ...deps, db: ctx.trx }, principal)
  const access = { ...deps, db: ctx.trx, configurationDirectories: ctx.configurationDirectories }
  const group = principal.scope.kind === 'group'
  if (group && (op.op === 'mkdir' || op.op === 'move_directory' || op.op === 'delete_directory'))
    throw new AbeleError('forbidden', 'groups do not authorize directory operations')
  // Check byte ownership before opening a candidate's frontmatter, including guessed SHAs.
  if ('sha' in op) {
    const uploaded = await ctx.trx
      .selectFrom('blob_uploads')
      .select('sha')
      .where('vault_id', '=', ctx.vaultId)
      .where('device_id', '=', principal.token.id)
      .where('sha', '=', op.sha)
      .executeTakeFirst()
    const named = uploaded
      ? uploaded
      : await ctx.trx
          .selectFrom('scope_versions')
          .innerJoin('versions', 'versions.id', 'scope_versions.version_id')
          .innerJoin('scope_members', (join) =>
            join
              .onRef('scope_members.file_id', '=', 'scope_versions.file_id')
              .onRef('scope_members.scope_id', '=', 'scope_versions.scope_id')
          )
          .select('versions.id')
          .where('scope_versions.scope_id', '=', principal.scope.id)
          .where('versions.blob_sha', '=', op.sha)
          .executeTakeFirst()
    if (!named)
      throw new AbeleError('not_found', 'upload these bytes through this token before committing')
  }
  const path =
    op.op === 'create' || op.op === 'mkdir'
      ? op.path
      : op.op === 'move' || op.op === 'move_directory'
        ? op.to_path
        : undefined
  if (path !== undefined) {
    const allowed = group
      ? await groupPathAllowed(access, principal.scope, path)
      : await covers(access, principal.scope, path)
    if (!allowed) throw new AbeleError('forbidden', 'destination is outside this scope')
    if (op.op === 'create' || op.op === 'move') await validateDestination(ctx, path, false)
  }
  if ('file_id' in op) {
    const current = await member(ctx.trx, principal.scope.id, op.file_id)
    const file = await ctx.trx
      .selectFrom('files')
      .select(['path', 'deleted_at', 'head_version_id'])
      .where('id', '=', op.file_id)
      .where('vault_id', '=', ctx.vaultId)
      .executeTakeFirst()
    // A deleted file can be edited/restored only with a previously visible base.
    const tombstone =
      file?.deleted_at &&
      file.head_version_id &&
      (await covers(access, principal.scope, file.path, op.file_id)) &&
      (await versionVisible(ctx.trx, principal.scope.id, op.file_id, file.head_version_id))
    const reentry =
      !current &&
      !file?.deleted_at &&
      group &&
      op.op === 'modify' &&
      file?.head_version_id === op.base_version_id &&
      (await ctx.trx
        .selectFrom('group_write_bases')
        .select('version_id')
        .where('token_id', '=', principal.token.id)
        .where('file_id', '=', op.file_id)
        .where('version_id', '=', op.base_version_id)
        .executeTakeFirst()) &&
      (await groupPathAllowed(access, principal.scope, file.path)) &&
      (await qualifies({ ...access, store: ctx.store }, principal.scope, file.path, op.sha))
    if (
      (!current && !tombstone && !reentry) ||
      (current && !(await covers(access, principal.scope, current.path, op.file_id)))
    )
      throw new AbeleError('not_found', 'no file in this scope')
    const base = op.op === 'restore' ? op.version_id : op.base_version_id
    if (
      !reentry &&
      current?.kind !== 'directory' &&
      !(await versionVisible(ctx.trx, principal.scope.id, op.file_id, base))
    )
      throw new AbeleError('not_found', 'no version in this scope')
  } else if (op.op === 'create') {
    const existing = await ctx.trx
      .selectFrom('files')
      .select(['id', 'path', 'head_version_id'])
      .where('vault_id', '=', ctx.vaultId)
      .where('path_ci', '=', caseKey(op.path))
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (existing && existing.path !== op.path)
      throw new AbeleError('path_taken', 'a different case spelling occupies this path')
    const known = existing && (await member(ctx.trx, principal.scope.id, existing.id))
    if (existing && !known) {
      const head =
        publication && existing.head_version_id
          ? await ctx.trx
              .selectFrom('versions')
              .select(['blob_sha', 'size'])
              .where('id', '=', existing.head_version_id)
              .executeTakeFirst()
          : undefined
      if (!head || head.blob_sha !== op.sha || head.size !== op.size)
        throw new AbeleError('not_found', 'no file in this scope')
      await ctx.trx
        .insertInto('group_assets')
        .values({
          space_id: ctx.vaultId,
          root_id: principal.scope.target_id,
          file_id: existing.id,
          published_by: principal.token.id,
          published_at: ctx.at.toISOString(),
        })
        .onConflict((oc) => oc.columns(['space_id', 'root_id', 'file_id']).doNothing())
        .execute()
    }
    if (
      group &&
      !known &&
      !publication &&
      !(await qualifies({ ...access, store: ctx.store }, principal.scope, op.path, op.sha))
    )
      throw new AbeleError('forbidden', 'new note does not belong to this group')
  }
  if (op.op === 'mkdir' || op.op === 'move_directory' || op.op === 'delete_directory')
    await validateDirectoryOp(ctx, op)
}

/** ONE authorization boundary around the retained engine and directory operations.
 * Credential checks, replay, visibility and all outputs share the engine transaction. */
export async function commitWithToken(
  deps: CommitDeps & AccessDeps,
  key: string,
  ops: V2CommitOp[],
  idempotencyKey?: string,
  choose?: (
    db: Transaction<Database>,
    principal: TokenPrincipal
  ) => Promise<Array<V2CommitOp | CommitOpResult>>,
  requestIdentity: unknown = ops,
  publication = false
): Promise<V2CommitResponse> {
  let principal = await authenticateToken(deps, key)
  let processed = 0
  const directoryDeletes = new Map<string, string>()
  let keyed: KeyedRun | undefined
  if (idempotencyKey !== undefined) {
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new AbeleError('invalid_request', 'invalid idempotency key')
    keyed = {
      actorId: principal.token.id,
      key: idempotencyKey,
      hash: createHash('sha256').update(JSON.stringify(requestIdentity)).digest('hex'),
      ttlMs: 0,
      answer: (response) => ({ cursor: response.head_seq, results: response.results }),
      filed: false,
    }
  }
  try {
    const response = await commitChosen(
      {
        ...deps,
        ...(keyed ? { keyed } : {}),
        before: async (ctx) => {
          principal = await authenticateToken({ ...deps, db: ctx.trx }, key)
          requireWrite(principal)
          await activeScope({ ...deps, db: ctx.trx }, principal)
          ctx.consumeUpload = async (sha) => {
            await ctx.trx
              .deleteFrom('blob_uploads')
              .where('vault_id', '=', ctx.vaultId)
              .where('device_id', '=', principal.token.id)
              .where('sha', '=', sha)
              .execute()
          }
          ctx.conflictVisible = async (fileId, versionId) =>
            Boolean(await member(ctx.trx, principal.scope.id, fileId)) &&
            (await versionVisible(ctx.trx, principal.scope.id, fileId, versionId))
          ctx.authorizeOutput = async (version) => {
            // Only genuine delete outputs from the preauthorized atomic tree may
            // finish after deleting the selector itself. Never authorize content.
            if (version.op === 'delete' && directoryDeletes.get(version.fileId) === version.path)
              return
            const access = { ...deps, db: ctx.trx }
            if (
              !(principal.scope.kind === 'group'
                ? await groupPathAllowed(access, principal.scope, version.path)
                : await covers(access, principal.scope, version.path))
            )
              throw new Error('engine output escaped the authorized scope; roll back the batch')
          }
          processed = await headSeqOf(ctx.trx, ctx.vaultId)
        },
        authorize: async (ctx, op) => {
          directoryDeletes.clear()
          await authorizeOp(ctx, deps, principal, op, publication)
          if (op.op !== 'delete_directory') return
          const access = {
            ...deps,
            db: ctx.trx,
            configurationDirectories: ctx.configurationDirectories,
          }
          const source = await member(ctx.trx, principal.scope.id, op.file_id)
          if (!source || source.kind !== 'directory')
            throw new AbeleError('not_found', 'no directory in this scope')
          const files = await ctx.trx
            .selectFrom('files')
            .select(['id', 'path', 'head_version_id'])
            .where('vault_id', '=', ctx.vaultId)
            .where('deleted_at', 'is', null)
            .execute()
          for (const file of files.filter((file) => file.path.startsWith(source.path + '/'))) {
            const visible = await member(ctx.trx, principal.scope.id, file.id)
            if (
              !visible ||
              visible.version_id !== file.head_version_id ||
              !(await covers(access, principal.scope, file.path, file.id))
            )
              throw new AbeleError('forbidden', 'directory contains files outside this scope')
            directoryDeletes.set(file.id, file.path)
          }
        },
        runDirectory: (ctx, op) => runDirectory(ctx, deps, op),
        afterOp: async (ctx) => {
          const versions = await ctx.trx
            .selectFrom('versions')
            .selectAll()
            .where('vault_id', '=', ctx.vaultId)
            .where('seq', '>', processed)
            .orderBy('seq')
            .execute()
          const affected = new Set<string>()
          if (publication)
            for (const id of await ancestors({ ...deps, db: ctx.trx }, ctx.vaultId, [
              principal.scope.target_id,
            ]))
              affected.add(id)
          const previouslyVisible = new Set<string>()
          if (principal.scope.kind === 'group')
            for (const v of versions)
              if (await member(ctx.trx, principal.scope.id, v.file_id))
                previouslyVisible.add(v.file_id)
          for (const v of versions) {
            const kind = (
              await ctx.trx
                .selectFrom('files')
                .select('kind')
                .where('id', '=', v.file_id)
                .executeTakeFirstOrThrow()
            ).kind
            const access = {
              ...deps,
              db: ctx.trx,
              configurationDirectories: ctx.configurationDirectories,
            }
            if (publication && principal.scope.kind === 'group' && v.blob_sha && kind !== 'note') {
              await ctx.trx
                .insertInto('group_assets')
                .values({
                  space_id: ctx.vaultId,
                  root_id: principal.scope.target_id,
                  file_id: v.file_id,
                  published_by: principal.token.id,
                  published_at: ctx.at.toISOString(),
                })
                .onConflict((oc) => oc.columns(['space_id', 'root_id', 'file_id']).doNothing())
                .execute()
              affected.add(principal.scope.target_id)
            }
            if (v.op === 'conflict') {
              const divergence = await ctx.trx
                .selectFrom('conflict_divergences')
                .select('original_file_id')
                .where('vault_id', '=', ctx.vaultId)
                .where('conflict_file_id', '=', v.file_id)
                .executeTakeFirst()
              if (divergence) {
                await ctx.trx
                  .insertInto('group_copies')
                  .values({
                    space_id: ctx.vaultId,
                    original_id: divergence.original_file_id,
                    file_id: v.file_id,
                  })
                  .onConflict((oc) =>
                    oc.columns(['space_id', 'original_id', 'file_id']).doNothing()
                  )
                  .execute()
                for (const id of await ancestors(access, ctx.vaultId, [
                  divergence.original_file_id,
                ]))
                  affected.add(id)
              }
            }
            const head = await ctx.trx
              .selectFrom('files')
              .select('head_version_id')
              .where('id', '=', v.file_id)
              .executeTakeFirstOrThrow()
            if (head.head_version_id === v.id)
              for (const id of await indexVersion({ ...access, store: ctx.store }, v, kind))
                affected.add(id)
            await recordFileVersion(
              { ...deps, db: ctx.trx, configurationDirectories: ctx.configurationDirectories },
              v,
              kind
            )
            if (v.blob_sha !== null)
              await ctx.trx
                .deleteFrom('blob_uploads')
                .where('vault_id', '=', ctx.vaultId)
                .where('device_id', '=', principal.token.id)
                .where('sha', '=', v.blob_sha)
                .execute()
            if (v.op !== 'delete') await ensureParents(ctx, deps, v.path, v.mtime)
          }
          await refreshGroups(
            { ...deps, db: ctx.trx, configurationDirectories: ctx.configurationDirectories },
            ctx.vaultId,
            affected,
            ctx.at.toISOString(),
            versions,
            ops.some((op) => op.op === 'move_directory' || op.op === 'delete_directory')
          )
          if (principal.scope.kind === 'group')
            for (const v of versions)
              if (
                v.op === 'modify' &&
                previouslyVisible.has(v.file_id) &&
                !(await member(ctx.trx, principal.scope.id, v.file_id))
              ) {
                // Write-only receipt for the exact departure head. It grants no read/history
                // authority and is invalidated by any subsequent private head advancement.
                await ctx.trx
                  .insertInto('group_write_bases')
                  .values({ token_id: principal.token.id, file_id: v.file_id, version_id: v.id })
                  .onConflict((oc) =>
                    oc.columns(['token_id', 'file_id']).doUpdateSet({ version_id: v.id })
                  )
                  .execute()
              }
          processed = await headSeqOf(ctx.trx, ctx.vaultId)
        },
      },
      principal.space.id,
      { kind: 'key', id: principal.token.id, name: principal.token.label },
      async (db) => {
        await addDaily(db, principal.space.id, principal.token.id, deps.now?.() ?? new Date(), {
          commits: 1,
        })
        const chosen = choose ? await choose(db, principal) : ops
        if (principal.scope.kind !== 'group' || publication) return chosen
        // A local author who removed the group can explicitly re-add it. Treat a fresh
        // create at its retained path as an exact-head edit, never a merge against hidden
        // private bytes or a path-based admission of somebody else's note.
        return Promise.all(
          chosen.map(async (op) => {
            if ('status' in op || op.op !== 'create') return op
            const known = await db
              .selectFrom('files')
              .innerJoin('group_write_bases', 'group_write_bases.file_id', 'files.id')
              .select(['files.id', 'files.head_version_id', 'group_write_bases.version_id'])
              .where('files.vault_id', '=', principal.space.id)
              .where('files.path', '=', op.path)
              .where('files.deleted_at', 'is', null)
              .where('group_write_bases.token_id', '=', principal.token.id)
              .executeTakeFirst()
            if (!known || known.head_version_id !== known.version_id) return op
            return {
              op: 'modify' as const,
              file_id: known.id,
              base_version_id: known.version_id,
              sha: op.sha,
              size: op.size,
              mtime: op.mtime,
            }
          })
        )
      }
    )
    return { cursor: response.head_seq, results: response.results }
  } catch (error) {
    if (error instanceof Replay) {
      return JSON.parse(error.response) as V2CommitResponse
    }
    throw error
  }
}
