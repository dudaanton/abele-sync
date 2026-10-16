import { sql, type Kysely } from 'kysely'
export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('access_tokens')
    .addColumn('read_only', 'integer', (c) =>
      c
        .notNull()
        .defaultTo(0)
        .check(sql`read_only in (0,1)`)
    )
    .execute()
}
