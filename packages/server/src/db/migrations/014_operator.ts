import { sql, type Kysely } from 'kysely'
export async function up(db: Kysely<unknown>) {
  await db.schema
    .alterTable('spaces')
    .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
    .execute()
  await db.schema.alterTable('spaces').addColumn('deleted_at', 'text').execute()
  await sql`update spaces set name = (select label from users where users.id = spaces.user_id)`.execute(
    db
  )
}
