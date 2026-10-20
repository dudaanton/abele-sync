import {
  resolveTokenItem,
  requireOwnerForItemServerDelete,
  detachItem,
  tokenItems,
} from './items.js'
import { addDaily } from '../history/activity.js'
import { randomUUID } from 'node:crypto'
import {
  AbeleError,
  V2DeleteScopeResponseSchema,
  type V2DeleteScopeResponse,
  type CommitOp,
} from '@abele/sync-protocol'
import { withVaultLock } from '../oplog/lock.js'
import { runEngineOp, type CommitDeps } from '../oplog/commit.js'
import { DELETE_SCOPE_REQUEST_HASH } from '../oplog/keyed.js'
import type { Ctx } from '../oplog/commitCtx.js'
import { getVaultSettings } from './spaceSettings.js'
import { authenticateToken, findTokenByKey, requireWrite, type AccessDeps } from './tokens.js'
import { activeScope, covers } from './visibility.js'
import { authorizeOp } from './commit.js'
import { runDirectory } from './directories.js'
import { recordDeletedVersions } from './deleteFolder.js'

const under = (path: string, root: string) =>
  root === '/' || path === root || path.startsWith(root + '/')

/** One narrowly scoped exception to live authentication: replay this secret's own deletion receipt. */
export async function deleteScope(
  deps: CommitDeps & AccessDeps,
  key: string,
  idempotencyKey: string,
  itemId = deps.itemId
): Promise<V2DeleteScopeResponse> {
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new AbeleError('invalid_request', 'invalid idempotency key')
  const requestHash =
    itemId === undefined ? DELETE_SCOPE_REQUEST_HASH : DELETE_SCOPE_REQUEST_HASH + ':item:' + itemId
  const initial = await findTokenByKey(deps, key)
  const outcome = await withVaultLock(deps.db, deps.dialect, initial.space_id, async (db) => {
    const access = { ...deps, db }
    const token = await findTokenByKey(access, key)
    const receipt = await db
      .selectFrom('idempotency')
      .selectAll()
      .where('actor_id', '=', token.id)
      .where('key', '=', idempotencyKey)
      .executeTakeFirst()
    if (receipt?.request_hash === requestHash) {
      return {
        replayed: true,
        response: V2DeleteScopeResponseSchema.parse(JSON.parse(receipt.response)),
      }
    }
    let p = await authenticateToken(access, key)
    // Management authority never supplies content authority. Keep the caller's
    // own live item scopes before resolving somebody else's deletion selector.
    const callerScopes =
      itemId === undefined || deps.itemId !== undefined
        ? [p.scope]
        : await db
            .selectFrom('access_scopes')
            .selectAll()
            .where('space_id', '=', p.space.id)
            .where(
              'id',
              'in',
              (await tokenItems(access, p.token))
                .filter((item) => item.removed_at === null)
                .map((item) => item.scope_id)
            )
            .execute()
    const requireCallerContent = async (path: string, id: string) => {
      for (const scope of callerScopes) if (await covers(access, scope, path, id)) return
      throw new AbeleError(
        'forbidden',
        'item deletion requires the caller’s own live content authority'
      )
    }
    let itemToken = p.token
    if (itemId !== undefined) {
      const row = await db
        .selectFrom('access_token_items')
        .select('token_id')
        .where('id', '=', itemId)
        .executeTakeFirst()
      const targetId =
        row?.token_id ?? (itemId.startsWith('primary:') ? itemId.slice(8) : p.token.id)
      itemToken = await requireOwnerForItemServerDelete(access, p, targetId)
      const item = await resolveTokenItem(access, itemToken, itemId)
      const scope = await db
        .selectFrom('access_scopes')
        .selectAll()
        .where('id', '=', item.scope_id)
        .where('space_id', '=', p.space.id)
        .executeTakeFirstOrThrow()
      const selected = await activeScope(access, { ...p, scope })
      await requireCallerContent(selected.path, selected.id)
      p = { ...p, scope }
    }
    requireWrite(p)
    const scope = await activeScope(access, p)
    if (receipt)
      throw new AbeleError(
        'idempotency_mismatch',
        'that idempotency key was used for a different request'
      )
    const at = deps.now?.() ?? new Date()
    const ctx: Ctx = {
      trx: db,
      store: deps.store,
      vaultId: p.space.id,
      actor: { kind: 'key', id: p.token.id, name: p.token.label },
      at,
      settings: await getVaultSettings(access, p.space.id),
      configurationDirectories: deps.configurationDirectories,
    }
    const start = (
      await db
        .selectFrom('vault_seq')
        .select('head_seq')
        .where('vault_id', '=', p.space.id)
        .executeTakeFirstOrThrow()
    ).head_seq
    const members = new Set(
      (
        await db
          .selectFrom('scope_members')
          .select('file_id')
          .where('scope_id', '=', p.scope.id)
          .execute()
      ).map((m) => m.file_id)
    )
    const allFiles = await db
      .selectFrom('files')
      .selectAll()
      .where('vault_id', '=', p.space.id)
      .where('deleted_at', 'is', null)
      .execute()
    const ops: CommitOp[] = []
    const selected = new Set<string>()
    for (const file of allFiles) {
      if (!members.has(file.id) || !(await covers(access, p.scope, file.path, file.id))) continue
      if (itemId !== undefined) await requireCallerContent(file.path, file.id)
      const op: CommitOp = {
        op: 'delete',
        file_id: file.id,
        base_version_id: file.head_version_id!,
      }
      // Preflight all files before deleting a group selector changes its graph authority.
      await authorizeOp(ctx, deps, p, op)
      ops.push(op)
      selected.add(file.id)
    }
    const allDirs = await db
      .selectFrom('directories')
      .selectAll()
      .where('space_id', '=', p.space.id)
      .where('deleted_at', 'is', null)
      .execute()
    const permittedDirs = new Set<string>()
    if (scope.kind === 'folder')
      for (const dir of allDirs) {
        if (dir.path !== '/' && members.has(dir.id) && (await covers(access, p.scope, dir.path))) {
          if (itemId !== undefined) await requireCallerContent(dir.path, dir.id)
          permittedDirs.add(dir.id)
        }
      }
    // Leave ancestors of private/excluded content intact; no scope deletion expands authority.
    const dirs = allDirs
      .filter(
        (dir) =>
          permittedDirs.has(dir.id) &&
          !allFiles.some((file) => under(file.path, dir.path) && !selected.has(file.id)) &&
          !allDirs.some((child) => under(child.path, dir.path) && !permittedDirs.has(child.id))
      )
      .sort((a, b) => b.path.length - a.path.length)
    const scopes = await db
      .selectFrom('access_scopes')
      .selectAll()
      .where('space_id', '=', p.space.id)
      .execute()
    const directoryIds = new Set(
      scope.kind === 'folder'
        ? allDirs.filter((dir) => under(dir.path, scope.path)).map((dir) => dir.id)
        : []
    )
    const dead = new Set(
      scopes
        .filter(
          (s) =>
            s.id === p.scope.id ||
            (s.kind === 'folder' ? directoryIds.has(s.target_id) : selected.has(s.target_id))
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
    for (const op of ops) {
      const result = await runEngineOp(ctx, op)
      if (result.status === 'rejected') throw new AbeleError(result.code, result.message)
    }
    for (const dir of dirs)
      await runDirectory(ctx, access, {
        op: 'delete_directory',
        file_id: dir.id,
        base_version_id: dir.version_id,
      })
    await recordDeletedVersions(ctx, access, start)
    const revoked: string[] = []
    for (const s of dead) {
      const rows = await db
        .updateTable('access_tokens')
        .set({ revoked_at: at.toISOString(), scope_deleted_at: at.toISOString() })
        .where('space_id', '=', p.space.id)
        .where((eb) =>
          eb.or([
            eb('scope_id', '=', s),
            eb(
              'id',
              'in',
              db
                .selectFrom('access_token_items')
                .select('token_id')
                .where('scope_id', '=', s)
                .where('removed_at', 'is', null)
            ),
          ])
        )
        .where('revoked_at', 'is', null)
        .$if(itemId !== undefined, (q) =>
          q.where('id', '!=', p.token.id).where('id', '!=', itemToken.id)
        )
        .returning('id')
        .execute()
      revoked.push(...rows.map((t) => t.id))
    }
    if (itemId !== undefined) await detachItem(access, itemToken, itemId)
    const cursor = (
      await db
        .selectFrom('vault_seq')
        .select('head_seq')
        .where('vault_id', '=', p.space.id)
        .executeTakeFirstOrThrow()
    ).head_seq
    await addDaily(db, p.space.id, p.token.id, at, { commits: 1 })
    const response: V2DeleteScopeResponse = { cursor, files: ops.length, revoked_tokens: revoked }
    await db
      .insertInto('audit')
      .values({
        id: randomUUID(),
        vault_id: p.space.id,
        actor_kind: 'key',
        actor_id: p.token.id,
        action: 'connection.delete',
        path: scope.path,
        result: 'applied',
        at: at.toISOString(),
        details: JSON.stringify({
          label: p.token.label,
          scope,
          files: ops.length,
          revoked_tokens: revoked,
        }),
      })
      .execute()
    await db
      .insertInto('idempotency')
      .values({
        actor_id: p.token.id,
        key: idempotencyKey,
        request_hash: requestHash,
        status: 200,
        response: JSON.stringify(response),
        created_at: at.toISOString(),
      })
      .execute()
    return { replayed: false, response }
  })
  if (!outcome.replayed) {
    deps.hub.notify(initial.space_id, outcome.response.cursor)
    for (const id of outcome.response.revoked_tokens) deps.hub.hangUp(id, 4004)
  }
  return outcome.response
}
