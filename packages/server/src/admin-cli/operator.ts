import { listDaily } from '../history/activity.js'
import { createInterface } from 'node:readline/promises'
import { stdin, stderr } from 'node:process'
import { Command } from 'commander'
import { sql } from 'kysely'
import type { AdminContext, AdminOutput } from './index.js'
import { createUser, effectiveScope, issueFromPrincipal } from '../access/tokens.js'
import { deleteFolder } from '../access/deleteFolder.js'
import { withVaultLock } from '../oplog/lock.js'
import { EventHub } from '../events/hub.js'
import { listTrash } from '../history/trash.js'
import { adminAudit, collectPurgedBlobs, purgeAfter, purgeVault } from '../access/vaultLifecycle.js'
import { generationPath, pruneRestoreCheckpoint } from '../restoreGeneration.js'

const gaps = [
  'daily transfer counters record successful responses, not individual transfer event timestamps',
  'client addresses are withheld for untrusted proxies/private peers; use timestamps are sampled once a minute',
  'socket presence is not shared with the operator process',
  'commit audit is best-effort per operation; daily counters count new committed batches',
]
type Context = AdminContext
type Options = {
  json?: boolean
  yes?: boolean
  now?: boolean
  confirmPurge?: boolean
  vault?: string
  connection?: string
  since?: string
  limit?: string
  folder?: string
  group?: string
  label?: string
  address?: string
}
function emit(out: AdminOutput, data: unknown, json?: boolean) {
  if (json) return out.log(JSON.stringify(data))
  const rows = Array.isArray(data) ? data : [data]
  if (!rows.length) out.log('(none)')
  for (const row of rows)
    out.log(
      Object.entries(row as Record<string, unknown>)
        .map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
        .join(' | ')
    )
}
export function resolveName<T extends { id: string }>(
  rows: T[],
  value: string,
  label: (row: T) => string
): T {
  const exact = rows.find((r) => r.id === value)
  if (exact) return exact
  const matches = rows.filter((r) => label(r) === value)
  if (matches.length === 1) return matches[0]!
  if (!matches.length) throw new Error('not found: ' + value)
  throw new Error(
    'ambiguous ' +
      value +
      '; candidates: ' +
      matches.map((r) => r.id + ' (' + label(r) + ')').join(', ')
  )
}
async function vault(ctx: Context, value: string) {
  return resolveName(await ctx.db.selectFrom('spaces').selectAll().execute(), value, (r) => r.name)
}
async function token(ctx: Context, value: string) {
  return resolveName(
    await ctx.db.selectFrom('access_tokens').selectAll().execute(),
    value,
    (r) => r.label
  )
}
/** Audit outlives vault/token rows. Archived UUIDs remain useful filters. */
function activityId<T extends { id: string }>(rows: T[], value: string, label: (row: T) => string) {
  if (rows.some((row) => row.id === value || label(row) === value))
    return resolveName(rows, value, label).id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value
  return resolveName(rows, value, label).id
}
async function connections(ctx: Context, space?: string) {
  let q = ctx.db.selectFrom('access_tokens').selectAll()
  if (space) q = q.where('space_id', '=', space)
  const result = []
  for (const t of await q.orderBy('created_at').orderBy('id').execute()) {
    const scope = await ctx.db
      .selectFrom('access_scopes')
      .selectAll()
      .where('id', '=', t.scope_id)
      .executeTakeFirstOrThrow()
    const resolved = await effectiveScope(
      { db: ctx.db, pepper: ctx.config.tokenPepper },
      { scope, space: { id: t.space_id } }
    )
    result.push({
      id: t.id,
      vault_id: t.space_id,
      label: t.label,
      read_only: t.read_only === 1,
      scope: resolved.scope,
      created: t.created_at,
      last_used: t.last_used_at,
      address: t.last_address,
      address_status: t.address_status,
      activity_daily: await listDaily(ctx.db, { vaultId: t.space_id, tokenId: t.id }),
      status: t.scope_deleted_at
        ? 'scope_deleted'
        : t.revoked_at
          ? 'revoked'
          : resolved.active
            ? 'active'
            : 'scope_unavailable',
      revoked_at: t.revoked_at,
    })
  }
  return result
}
async function stats(ctx: Context, id: string, prefix?: string) {
  const files = await ctx.db
    .selectFrom('files')
    .leftJoin('versions', 'versions.id', 'files.head_version_id')
    .select(['files.path', 'files.deleted_at', 'versions.size', 'versions.created_at'])
    .where('files.vault_id', '=', id)
    .execute()
  const selected = files.filter((f) => prefix === undefined || f.path.startsWith(prefix + '/'))
  const live = selected.filter((f) => !f.deleted_at)
  const trash = (await listTrash(ctx.db, id)).filter(
    (f) => prefix === undefined || f.path.startsWith(prefix + '/')
  )
  let audit = ctx.db.selectFrom('audit').select('at').where('vault_id', '=', id)
  if (prefix !== undefined)
    audit = audit.where((eb) =>
      eb.or([
        eb('path', '=', prefix),
        sql<boolean>`path like ${prefix.replace(/[!%_]/g, '!$&') + '/%'} escape '!'`,
      ])
    )
  const latest = await audit.orderBy('at', 'desc').limit(1).executeTakeFirst()
  return {
    file_count: live.length,
    bytes: live.reduce((n, f) => n + (f.size ?? 0), 0),
    trash_bytes: trash.reduce((n, f) => n + f.size, 0),
    last_change:
      [...selected.map((f) => f.created_at), latest?.at ?? null]
        .filter((s): s is string => s !== null)
        .sort()
        .at(-1) ?? null,
  }
}
async function summary(ctx: Context, v: Awaited<ReturnType<typeof vault>>) {
  const owner = await ctx.db
    .selectFrom('users')
    .select(['id', 'label'])
    .where('id', '=', v.user_id)
    .executeTakeFirstOrThrow()
  return {
    id: v.id,
    name: v.name,
    owner,
    ...(await stats(ctx, v.id)),
    deleted_at: v.deleted_at,
    purge_after: v.deleted_at ? new Date(purgeAfter(v.settings, v.deleted_at)).toISOString() : null,
  }
}
async function confirm(out: AdminOutput, opts: Options, preview: unknown) {
  if (!opts.json) emit(out, preview)
  else if (!opts.yes) out.error(JSON.stringify(preview))
  if (opts.yes) return
  if (!stdin.isTTY)
    throw new Error('confirmation requires a terminal; use --yes after reviewing the preview')
  const rl = createInterface({ input: stdin, output: stderr })
  try {
    if ((await rl.question('Type yes to confirm: ')).trim() !== 'yes') throw new Error('cancelled')
  } finally {
    rl.close()
  }
}
export function registerOperator(
  program: Command,
  out: AdminOutput,
  choose: (run: (ctx: Context) => Promise<void>) => void
) {
  program.option('--json', 'machine-readable JSON')
  const bind = (
    cmd: Command,
    run: (ctx: Context, args: string[], opts: Options) => Promise<void>
  ) => {
    cmd.action((...args: unknown[]) => {
      const command = args.at(-1) as Command
      const values = args.slice(0, -2) as string[]
      const opts = command.optsWithGlobals<Options>()
      choose((ctx) => run(ctx, values, opts))
    })
    return cmd
  }
  const vaults = program.command('vaults').description('operator vault management')
  bind(vaults.command('list'), async (ctx, _a, o) => {
    const rows = await ctx.db
      .selectFrom('spaces')
      .selectAll()
      .orderBy('created_at')
      .orderBy('id')
      .execute()
    emit(out, await Promise.all(rows.map((v) => summary(ctx, v))), o.json)
  })
  bind(vaults.command('show <vault>'), async (ctx, [v], o) => {
    const row = await vault(ctx, v!)
    const dirs = await ctx.db
      .selectFrom('directories')
      .select('path')
      .where('space_id', '=', row.id)
      .where('deleted_at', 'is', null)
      .execute()
    const folders = await Promise.all(
      dirs
        .filter((d) => d.path !== '/' && d.path.split('/').length <= 2)
        .map(async (d) => ({ path: d.path, ...(await stats(ctx, row.id, d.path)) }))
    )
    emit(
      out,
      {
        ...(await summary(ctx, row)),
        folders,
        connections: await connections(ctx, row.id),
        activity_daily: await listDaily(ctx.db, { vaultId: row.id, aggregate: true }),
        not_recorded: gaps,
      },
      o.json
    )
  })
  bind(
    vaults.command('create <name>').requiredOption('--address <url>', 'public server address'),
    async (ctx, [name], o) => {
      const issued = await createUser(
        { db: ctx.db, pepper: ctx.config.tokenPepper, dialect: ctx.dialect },
        name!,
        o.address!
      )
      await adminAudit(
        ctx.db,
        (
          await ctx.db
            .selectFrom('access_tokens')
            .select('space_id')
            .where('id', '=', issued.info.id)
            .executeTakeFirstOrThrow()
        ).space_id,
        'vault.create',
        { name }
      )
      emit(out, issued, o.json)
    }
  )
  bind(vaults.command('rename <vault> <name>'), async (ctx, [v, name], o) => {
    if (!name?.trim()) throw new Error('name must not be empty')
    const row = await vault(ctx, v!)
    await withVaultLock(ctx.db, ctx.dialect, row.id, async (db) => {
      await db.updateTable('spaces').set({ name }).where('id', '=', row.id).execute()
      await adminAudit(db, row.id, 'vault.rename', { name })
    })
    emit(out, { id: row.id, name }, o.json)
  })
  bind(
    vaults
      .command('delete <vault>')
      .option('--yes', 'confirm deletion')
      .option('--now', 'purge retained data now')
      .option('--confirm-purge', 'second explicit acknowledgement of permanent purge'),
    async (ctx, [v], o) => {
      if (o.now && !o.confirmPurge) throw new Error('--now requires --confirm-purge')
      if (o.confirmPurge && !o.now) throw new Error('--confirm-purge requires --now')
      const row = await vault(ctx, v!)
      const preview = {
        ...(await summary(ctx, row)),
        connections: (await connections(ctx, row.id)).length,
        action: o.now ? 'permanent purge' : 'mark deleted; revoke all connections',
      }
      await confirm(out, o, preview)
      const shas = await withVaultLock(ctx.db, ctx.dialect, row.id, async (db) => {
        const at = new Date().toISOString()
        const current = await db
          .selectFrom('spaces')
          .select('deleted_at')
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow()
        await db
          .updateTable('spaces')
          .set({ deleted_at: current.deleted_at ?? at })
          .where('id', '=', row.id)
          .execute()
        await db
          .updateTable('access_tokens')
          .set({ revoked_at: at, scope_deleted_at: at })
          .where('space_id', '=', row.id)
          .where('revoked_at', 'is', null)
          .execute()
        await adminAudit(db, row.id, 'vault.delete', { immediate: !!o.now })
        const versions = o.now
          ? await db
              .selectFrom('versions')
              .select('blob_sha')
              .where('vault_id', '=', row.id)
              .execute()
          : []
        if (o.now) await purgeVault(db, row.id)
        return versions.flatMap((v) => (v.blob_sha ? [v.blob_sha] : []))
      })
      await pruneRestoreCheckpoint(ctx.db, generationPath(ctx.config.blobDir))
      const blobs_removed = o.now ? await collectPurgedBlobs(ctx.db, ctx.store, shas) : 0
      emit(
        out,
        { id: row.id, status: o.now ? 'purged' : 'deleted', blobs_removed, preview },
        o.json
      )
    }
  )
  const cons = program
    .command('connections')
    .description('manage durable token/device connections (not live sockets)')
  bind(cons.command('list').option('--vault <vault>', 'filter vault'), async (ctx, _a, o) =>
    emit(out, await connections(ctx, o.vault ? (await vault(ctx, o.vault)).id : undefined), o.json)
  )
  bind(cons.command('show <connection>'), async (ctx, [id], o) => {
    const t = await token(ctx, id!)
    emit(
      out,
      (await connections(ctx, t.space_id)).find((c) => c.id === t.id),
      o.json
    )
  })
  for (const action of ['rename', 'revoke'] as const)
    bind(
      cons.command(action + ' <connection>' + (action === 'rename' ? ' <label>' : '')),
      async (ctx, [id, label], o) => {
        if (action === 'rename' && !label?.trim()) throw new Error('label must not be empty')
        const t = await token(ctx, id!)
        await withVaultLock(ctx.db, ctx.dialect, t.space_id, async (db) => {
          await db
            .updateTable('access_tokens')
            .set(action === 'rename' ? { label: label! } : { revoked_at: new Date().toISOString() })
            .where('id', '=', t.id)
            .execute()
          await adminAudit(db, t.space_id, 'connection.' + action, {
            token_id: t.id,
            ...(label ? { label } : {}),
          })
        })
        emit(out, { id: t.id, status: action === 'rename' ? 'renamed' : 'revoked' }, o.json)
      }
    )
  bind(
    cons
      .command('create <vault>')
      .requiredOption('--label <label>', 'connection label')
      .option('--folder <path>', 'folder scope; default /')
      .option('--group <id-or-path>', 'group note scope'),
    async (ctx, [v], o) => {
      if (o.folder && o.group) throw new Error('choose --folder or --group')
      const row = await vault(ctx, v!)
      const issued = await withVaultLock(ctx.db, ctx.dialect, row.id, async (db) => {
        const current = await db
          .selectFrom('spaces')
          .selectAll()
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow()
        if (current.deleted_at) throw new Error('vault is deleted')
        const root = await db
          .selectFrom('directories')
          .selectAll()
          .where('space_id', '=', row.id)
          .where('path', '=', '/')
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow()
        const scope = await db
          .selectFrom('access_scopes')
          .selectAll()
          .where('target_id', '=', root.id)
          .where('boundary_scope_id', 'is', null)
          .executeTakeFirstOrThrow()
        const parent = await db
          .selectFrom('access_tokens')
          .selectAll()
          .where('scope_id', '=', scope.id)
          .where('read_only', '=', 0)
          .executeTakeFirstOrThrow()
        let target: string
        if (o.group)
          target = resolveName(
            await db
              .selectFrom('files')
              .select(['id', 'path'])
              .where('vault_id', '=', row.id)
              .where('kind', '=', 'note')
              .where('deleted_at', 'is', null)
              .execute(),
            o.group,
            (f) => f.path
          ).id
        else
          target = resolveName(
            await db
              .selectFrom('directories')
              .select(['id', 'path'])
              .where('space_id', '=', row.id)
              .where('deleted_at', 'is', null)
              .execute(),
            o.folder ?? '/',
            (d) => d.path
          ).id
        const value = await issueFromPrincipal(
          {
            db,
            pepper: ctx.config.tokenPepper,
            dialect: ctx.dialect,
            configurationDirectories: ctx.config.configurationDirectories,
          },
          { token: parent, scope, space: current },
          { label: o.label!, scope: { kind: o.group ? 'group' : 'folder', id: target } }
        )
        await adminAudit(db, row.id, 'connection.create', {
          token_id: value.info.id,
          label: o.label,
        })
        return value
      })
      emit(out, issued, o.json)
    }
  )
  bind(
    program.command('folders').command('delete <vault> <path>').option('--yes', 'confirm deletion'),
    async (ctx, [v, path], o) => {
      const row = await vault(ctx, v!)
      if (row.deleted_at) throw new Error('vault is deleted')
      const preview = {
        vault: row.id,
        path,
        ...(await stats(ctx, row.id, path)),
        action: 'trash subtree and revoke its scoped connections',
      }
      await confirm(out, o, preview)
      const result = await deleteFolder(
        {
          ...ctx,
          pepper: ctx.config.tokenPepper,
          configurationDirectories: ctx.config.configurationDirectories,
          hub: new EventHub(),
        },
        row.id,
        path!,
        { kind: 'system', id: 'operator:local', name: 'Server operator' }
      )
      emit(out, { ...result, preview }, o.json)
    }
  )
  bind(
    program
      .command('activity')
      .alias('log')
      .option('--vault <vault>', 'filter vault')
      .option('--connection <connection>', 'filter connection')
      .option('--since <timestamp>', 'ISO timestamp')
      .option('--limit <count>', 'maximum events', '100'),
    async (ctx, _a, o) => {
      const limit = Number(o.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 10000)
        throw new Error('--limit must be 1..10000')
      if (o.since && !Number.isFinite(Date.parse(o.since)))
        throw new Error('--since must be an ISO timestamp')
      const v = o.vault
        ? activityId(
            await ctx.db.selectFrom('spaces').selectAll().execute(),
            o.vault,
            (row) => row.name
          )
        : undefined
      const t = o.connection
        ? activityId(
            await ctx.db.selectFrom('access_tokens').selectAll().execute(),
            o.connection,
            (row) => row.label
          )
        : undefined
      let q = ctx.db.selectFrom('audit').selectAll()
      if (v) q = q.where('vault_id', '=', v)
      if (t)
        q = q.where((eb) => eb.or([eb('actor_id', '=', t), eb('details', 'like', '%' + t + '%')]))
      if (o.since) q = q.where('at', '>=', new Date(o.since).toISOString())
      const events = await q.orderBy('at', 'desc').orderBy('id', 'desc').limit(limit).execute()
      const event_counts: Record<string, number> = {}
      for (const event of events) {
        const key = `${event.action}:${event.result}`
        event_counts[key] = (event_counts[key] ?? 0) + 1
      }
      emit(
        out,
        {
          events: events.map((e) => ({ ...e, details: JSON.parse(e.details) })),
          event_counts,
          daily: await listDaily(ctx.db, {
            ...(v ? { vaultId: v } : {}),
            ...(t ? { tokenId: t } : {}),
            ...(o.since ? { since: new Date(o.since).toISOString() } : {}),
            limit,
          }),
          connections: (await connections(ctx, v)).filter((c) => !t || c.id === t).slice(0, limit),
          not_recorded: gaps,
        },
        o.json
      )
    }
  )
}
