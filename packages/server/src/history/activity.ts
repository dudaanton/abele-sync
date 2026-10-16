import { isIP } from 'node:net'
import { sql, type Kysely } from 'kysely'
import type { FastifyRequest, FastifyInstance } from 'fastify'
import type { Database } from '../db/schema.js'
import type { AppDeps } from '../api/app.js'
import type { TokenPrincipal } from '../access/tokens.js'
import { operationalLog } from '../api/operationalLog.js'

export const dailyFields = [
  'uploaded_files',
  'uploaded_bytes',
  'downloaded_files',
  'downloaded_bytes',
  'commits',
] as const
type Deltas = Partial<Record<(typeof dailyFields)[number], number>>
declare module 'fastify' {
  interface FastifyRequest {
    tokenActivity?: { vaultId: string; tokenId: string }
    transferActivity?: Deltas
  }
}
export function clientAddress(
  request: FastifyRequest,
  trustProxy: AppDeps['config']['trustProxy']
) {
  const ip = request.ip.replace(/^::ffff:/i, '')
  const forwarded = !!(
    request.headers['x-forwarded-for'] ||
    request.headers.forwarded ||
    request.headers['x-real-ip'] ||
    request.headers.via
  )
  const trusted = !!trustProxy && (request.ips?.length ?? 0) > 1
  const privatePeer =
    /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|::$|f[cd]|fe[89ab])/i.test(
      ip
    )
  if (!isIP(ip) || ((forwarded || trustProxy) && !trusted) || (!trusted && privatePeer))
    return { last_address: null, address_status: 'proxy' }
  return { last_address: ip, address_status: 'client' }
}
/** One matching UPDATE per token per rolling minute, even across independent server processes. */
export async function recordUse(deps: AppDeps, request: FastifyRequest, p: TokenPrincipal) {
  request.tokenActivity = { vaultId: p.space.id, tokenId: p.token.id }
  const at = deps.now?.() ?? new Date()
  const cutoff = new Date(at.getTime() - 60000).toISOString()
  if (p.token.last_used_at !== null && p.token.last_used_at > cutoff) return
  try {
    await deps.db
      .updateTable('access_tokens')
      .set({ last_used_at: at.toISOString(), ...clientAddress(request, deps.config.trustProxy) })
      .where('id', '=', p.token.id)
      .where('revoked_at', 'is', null)
      .where((eb) => eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<=', cutoff)]))
      .execute()
  } catch (error) {
    operationalLog(deps.db, 'token use sample failed', error)
  }
}
export async function addDaily(
  db: Kysely<Database>,
  vaultId: string,
  tokenId: string,
  at: Date,
  deltas: Deltas
) {
  const values = {
    vault_id: vaultId,
    token_id: tokenId,
    day: at.toISOString().slice(0, 10),
    uploaded_files: 0,
    uploaded_bytes: 0,
    downloaded_files: 0,
    downloaded_bytes: 0,
    commits: 0,
    ...deltas,
  }
  await db
    .insertInto('activity_daily')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['vault_id', 'token_id', 'day']).doUpdateSet({
        uploaded_files: sql<number>`activity_daily.uploaded_files + excluded.uploaded_files`,
        uploaded_bytes: sql<number>`activity_daily.uploaded_bytes + excluded.uploaded_bytes`,
        downloaded_files: sql<number>`activity_daily.downloaded_files + excluded.downloaded_files`,
        downloaded_bytes: sql<number>`activity_daily.downloaded_bytes + excluded.downloaded_bytes`,
        commits: sql<number>`activity_daily.commits + excluded.commits`,
      })
    )
    .execute()
}
export function registerActivity(app: FastifyInstance, deps: AppDeps) {
  // Keep exact totals, but coalesce transfer telemetry independently of request volume.
  // The map and each in-flight batch have a fixed bound; no per-request timer or queue.
  const pending = new Map<string, { vaultId: string; tokenId: string; at: Date; deltas: Deltas }>()
  // Publish the first sample immediately so a newly used connection is visible to
  // the operator. Bound this cache too; eviction can cause another immediate sample.
  const sampled = new Set<string>()
  let flushing: Promise<void> | undefined
  const flush = (): Promise<void> => {
    if (flushing) return flushing
    const batch = [...pending.values()]
    pending.clear()
    flushing = (async () => {
      for (const item of batch) {
        try {
          await addDaily(deps.db, item.vaultId, item.tokenId, item.at, item.deltas)
        } catch (error) {
          operationalLog(deps.db, 'activity counters failed', error)
        }
      }
    })().finally(() => {
      flushing = undefined
    })
    return flushing
  }
  const timer = setInterval(() => {
    void flush()
  }, 250)
  timer.unref()
  app.addHook('onClose', async () => {
    clearInterval(timer)
    await flushing
    if (pending.size) await flush()
  })
  app.addHook('onResponse', async (request, reply) => {
    const actor = request.tokenActivity
    if (!actor || !reply.raw.writableFinished || reply.statusCode >= 300) return
    let deltas = request.transferActivity
    if (
      request.method === 'GET' &&
      /^\/v2\/files\/[^/?]+\/content(?:\?|$)/.test(request.url) &&
      (reply.statusCode === 200 || reply.statusCode === 206)
    ) {
      deltas = {
        downloaded_files: 1,
        downloaded_bytes: Number(reply.getHeader('content-length') ?? 0),
      }
    }
    if (!deltas) return
    const at = deps.now?.() ?? new Date()
    const key = actor.tokenId + ':' + at.toISOString().slice(0, 10)
    if (!sampled.has(key)) {
      if (sampled.size >= 1024) sampled.delete(sampled.values().next().value!)
      sampled.add(key)
      try {
        await addDaily(deps.db, actor.vaultId, actor.tokenId, at, deltas)
      } catch (error) {
        operationalLog(deps.db, 'activity counters failed', error)
      }
      return
    }
    while (!pending.has(key) && pending.size >= 1024) await flush()
    let item = pending.get(key)
    if (!item) {
      item = { ...actor, at, deltas: {} }
      pending.set(key, item)
    }
    for (const field of dailyFields)
      if (deltas[field] !== undefined)
        item.deltas[field] = (item.deltas[field] ?? 0) + deltas[field]
  })
}
export async function listDaily(
  db: Kysely<Database>,
  opts: {
    vaultId?: string
    tokenId?: string
    since?: string
    limit?: number
    aggregate?: boolean
  } = {}
) {
  let query = db.selectFrom('activity_daily')
  if (opts.vaultId) query = query.where('vault_id', '=', opts.vaultId)
  if (opts.tokenId) query = query.where('token_id', '=', opts.tokenId)
  if (opts.since) query = query.where('day', '>=', opts.since.slice(0, 10))
  const rows = opts.aggregate
    ? await query
        .select('day')
        .select((eb) => dailyFields.map((field) => eb.fn.sum<number>(field).as(field)))
        .groupBy('day')
        .orderBy('day', 'desc')
        .limit(opts.limit ?? 30)
        .execute()
    : await query
        .selectAll()
        .orderBy('day', 'desc')
        .orderBy('token_id')
        .limit(opts.limit ?? 30)
        .execute()
  return rows.map((row) => ({
    ...row,
    ...Object.fromEntries(dailyFields.map((field) => [field, Number(row[field])])),
  }))
}
