import type { FileKind, Usage } from '@abele/sync-protocol'
import { sql, type Kysely, type Transaction } from 'kysely'
import { readJson, writeJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import { getVaultSettings } from '../vault/vaults.js'
import { lastWithContent } from './trash.js'

/**
 * What a vault holds, counted from the version rows themselves. Every version
 * of every file is in exactly one of three places:
 *
 * - live: the head version of a file that is not deleted;
 * - trash: the last version with bytes of a file that is deleted;
 * - history: every other version, the empty delete rows included.
 *
 * This phase counts them on each request rather than keeping a running total;
 * `usage_daily` is written as commits land, for the day-by-day roll-up, and is
 * not what these totals are read from.
 */

/** One file's history footprint. */
export interface HistoryTotal {
  file_id: string
  path: string
  history_bytes: number
  versions: number
}

/** How one written version moves the vault's byte and file counts. */
export interface UsageDelta {
  live: number
  history: number
  trash: number
  kind: FileKind
  countDelta: number
}

/** What the vault holds now: its bytes by place and by kind, against its quota. */
export async function usage(db: Kysely<Database>, vaultId: string): Promise<Usage> {
  const kinds = await db
    .selectFrom('files as f')
    .innerJoin('versions as h', 'h.id', 'f.head_version_id')
    .select((eb) => [
      'f.kind as kind',
      eb.fn.sum<number>('h.size').as('live_bytes'),
      eb.fn.count<number>('f.id').as('count'),
    ])
    .where('f.vault_id', '=', vaultId)
    .where('f.deleted_at', 'is', null)
    .groupBy('f.kind')
    .execute()

  const all = await db
    .selectFrom('versions')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('size'), sql<number>`0`).as('total'))
    .where('vault_id', '=', vaultId)
    .executeTakeFirst()

  const trashed = await db
    .selectFrom('versions as v')
    .innerJoin('files as f', 'f.id', 'v.file_id')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('v.size'), sql<number>`0`).as('total'))
    .where('f.vault_id', '=', vaultId)
    .where('f.deleted_at', 'is not', null)
    .where('v.blob_sha', 'is not', null)
    .where(lastWithContent())
    .executeTakeFirst()

  const byKind: Usage['by_kind'] = {}
  let live = 0
  for (const row of kinds) {
    const bytes = num(row.live_bytes)
    live += bytes
    byKind[row.kind] = { live_bytes: bytes, count: num(row.count) }
  }
  const trash = num(trashed?.total)
  // What is left over once the live and the trashed versions are set aside.
  const history = num(all?.total) - live - trash
  if (history < 0) {
    // Rows that do not add up are the server's own doing, not the caller's: a
    // plain error, so the client is told `internal` and only the log is told why.
    throw new Error(
      `vault ${vaultId} counts ${live} live and ${trash} trashed bytes out of ${num(all?.total)}`
    )
  }
  return {
    live_bytes: live,
    history_bytes: history,
    trash_bytes: trash,
    quota_bytes: (await getVaultSettings({ db }, vaultId)).quota_bytes,
    by_kind: byKind,
  }
}

/**
 * The files whose history weighs most, heaviest first — what a vault over its
 * quota would prune. A file whose only version is the one it still shows has no
 * history at all and is left out; sorted as they are, those are the tail.
 */
export async function topHistory(
  db: Kysely<Database>,
  vaultId: string,
  n: number
): Promise<HistoryTotal[]> {
  const { rows } = await sql<HistoryTotal>`
    select v.file_id as file_id,
           f.path as path,
           sum(case when f.deleted_at is null and v.id = f.head_version_id then 0
                    when f.deleted_at is not null and v.blob_sha is not null
                         and v.no = (select max(v2.no) from versions v2
                                     where v2.file_id = v.file_id and v2.blob_sha is not null) then 0
                    else v.size end) as history_bytes,
           count(*) as versions
    from versions as v
    join files as f on f.id = v.file_id
    where v.vault_id = ${vaultId}
    group by v.file_id, f.path
    order by history_bytes desc
    limit ${n}
  `.execute(db)

  return rows
    .map((row) => ({
      file_id: row.file_id,
      path: row.path,
      history_bytes: num(row.history_bytes),
      versions: num(row.versions),
    }))
    .filter((row) => row.history_bytes > 0)
}

/**
 * Record a version's effect on the day's usage row, so the roll-up has a row
 * per day of what moved. Read and write rather than one upserting statement:
 * `by_kind` is JSON no dialect can add to in place. The caller commits under
 * the vault's lock, so no second writer is inside this row's day at the time.
 */
export async function bumpUsage(
  trx: Transaction<Database>,
  vaultId: string,
  day: string,
  delta: UsageDelta
): Promise<void> {
  const row = await trx
    .selectFrom('usage_daily')
    .select(['live_bytes', 'history_bytes', 'trash_bytes', 'by_kind'])
    .where('vault_id', '=', vaultId)
    .where('day', '=', day)
    .executeTakeFirst()

  const byKind: Usage['by_kind'] = row === undefined ? {} : readJson(row.by_kind)
  const kind = byKind[delta.kind] ?? { live_bytes: 0, count: 0 }
  byKind[delta.kind] = {
    live_bytes: kind.live_bytes + delta.live,
    count: kind.count + delta.countDelta,
  }
  const moved = {
    live_bytes: (row?.live_bytes ?? 0) + delta.live,
    history_bytes: (row?.history_bytes ?? 0) + delta.history,
    trash_bytes: (row?.trash_bytes ?? 0) + delta.trash,
    by_kind: writeJson(byKind),
  }

  if (row === undefined) {
    await trx
      .insertInto('usage_daily')
      .values({ vault_id: vaultId, day, ...moved })
      .execute()
    return
  }
  await trx
    .updateTable('usage_daily')
    .set(moved)
    .where('vault_id', '=', vaultId)
    .where('day', '=', day)
    .execute()
}

/** Postgres hands a sum or a count back as a string; sqlite as a number. */
const num = (value: number | string | null | undefined): number => Number(value ?? 0)
