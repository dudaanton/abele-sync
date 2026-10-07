import type { Ctx } from '../oplog/commitCtx.js'
import type { ScopedAuthority } from './authority.js'
import { groupSponsor } from './groups/writePolicy.js'
/** Identity-specific persisted sponsorship, not a caller supplied path exception.
 * Used only alongside ordinary admitted-current/eligible-trash authorization.
 */
export async function retainedNativeSponsor(ctx: Ctx, a: ScopedAuthority, fileId: string) {
  if (a.selector.kind !== 'folder') return undefined
  const native = await ctx.trx
    .selectFrom('scope_native_files')
    .select('file_id')
    .where('grant_id', '=', a.principal.grant_id)
    .where('file_id', '=', fileId)
    .executeTakeFirst()
  if (!native) return undefined
  const sponsors = await ctx.trx
    .selectFrom('scope_extra_entries as entry')
    .innerJoin('scope_extra_sponsors as sponsor', 'sponsor.entry_id', 'entry.id')
    .select(['sponsor.note_id', 'sponsor.interval_id', 'sponsor.admission_generation'])
    .where('entry.grant_id', '=', a.principal.grant_id)
    .where('entry.vault_id', '=', ctx.vaultId)
    .where('entry.file_id', '=', fileId)
    .where('entry.origin', '=', 'native')
    .where('entry.withdrawn_at', 'is', null)
    .where('sponsor.intrinsic', '=', 1)
    .limit(65)
    .execute()
  if (sponsors.length > 64) return undefined
  for (const sponsor of sponsors) {
    try {
      const current = await groupSponsor(ctx, a, sponsor.note_id)
      if (
        current.interval_id === sponsor.interval_id &&
        current.generation === sponsor.admission_generation
      )
        return sponsor.note_id
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'not_found') throw error
    }
  }
  return undefined
}
