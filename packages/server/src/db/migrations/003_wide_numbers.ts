import { PostgresAdapter, type Kysely } from 'kysely'

/**
 * Epoch milliseconds, byte counts and the per-vault sequence outgrow 32 bits:
 * an mtime of today already does, and a vault's history passes 2 GiB soon
 * enough. `001_init` called these `integer`, which is 64-bit in SQLite and
 * 32-bit in Postgres, so on Postgres they are widened to `bigint` here.
 * SQLite needs nothing: its integers are already eight bytes.
 */
export const WIDE_COLUMNS: readonly (readonly [table: string, columns: readonly string[]])[] = [
  ['versions', ['seq', 'size', 'mtime']],
  ['vault_seq', ['head_seq']],
  ['blobs', ['size']],
  ['uploads', ['size', 'part_size']],
  ['usage_daily', ['live_bytes', 'history_bytes', 'trash_bytes']],
]

const isPostgres = (db: Kysely<unknown>): boolean =>
  db.getExecutor().adapter instanceof PostgresAdapter

export async function up(db: Kysely<unknown>): Promise<void> {
  await retype(db, 'bigint')
}

/**
 * One-way once real data exists: an epoch-ms mtime does not fit `integer`, so narrowing
 * fails on the first row that holds one — which, on Postgres, is every version written since
 * `up`. It runs only on a database whose values all still fit, such as a fresh one.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await retype(db, 'integer')
}

/** One `alter table` per table with all of its columns, so Postgres rewrites each table once. */
async function retype(db: Kysely<unknown>, type: 'bigint' | 'integer'): Promise<void> {
  if (!isPostgres(db)) return
  for (const [table, columns] of WIDE_COLUMNS) {
    const [first, ...rest] = columns
    if (first === undefined) continue
    let statement = db.schema.alterTable(table).alterColumn(first, (c) => c.setDataType(type))
    for (const column of rest) {
      statement = statement.alterColumn(column, (c) => c.setDataType(type))
    }
    await statement.execute()
  }
}
