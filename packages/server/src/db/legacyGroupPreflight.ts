import type { Kysely } from 'kysely'
import type { Database } from './schema.js'
/** No deployed database has group facts. Refuse any pre-key derived group
 * evidence instead of silently re-attributing possibly corrupted origins.
 * Operational recovery/export-import needs its own reviewed stopped-writer plan.
 */
export async function assertNoLegacyGroupEvidence(db: Kysely<Database>): Promise<void> {
  const fail = () => {
    throw new Error(
      'pre-010 group evidence requires reviewed recovery/export-import; never delete facts or edit journals to bypass this refusal'
    )
  }
  for (const table of [
    'scope_group_parse_facts',
    'scope_group_bindings',
    'scope_group_origins',
    'scope_group_progress',
    'scope_group_dirty',
  ] as const) {
    if (await db.selectFrom(table).selectAll().limit(1).executeTakeFirst()) fail()
  }
  for (const table of [
    'scope_current_members',
    'scope_version_admissions',
    'scope_admission_intervals',
  ] as const) {
    if (
      await db
        .selectFrom(table)
        .innerJoin('scope_grants', 'scope_grants.id', `${table}.grant_id`)
        .select('scope_grants.id')
        .where('scope_grants.selector_kind', '=', 'group')
        .limit(1)
        .executeTakeFirst()
    )
      fail()
  }
}
