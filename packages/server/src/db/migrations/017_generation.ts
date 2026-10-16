import { randomUUID } from 'node:crypto'
import type { Kysely } from 'kysely'

export async function up(db: Kysely<unknown>) {
  await db.schema
    .createIndex('directories_restore_head')
    .on('directories')
    .columns(['space_id', 'seq'])
    .execute()
  await db.schema
    .createTable('restore_generation')
    .addColumn('id', 'integer', (c) => c.primaryKey())
    .addColumn('generation', 'text', (c) => c.notNull())
    .execute()
  await (db as Kysely<import('../schema.js').Database>)
    .insertInto('restore_generation')
    .values({ id: 1, generation: randomUUID() })
    .execute()
}
