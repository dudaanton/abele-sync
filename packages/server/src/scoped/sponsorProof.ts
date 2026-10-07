import { AbeleError, credentialFacet, IntrinsicSponsorProofSchema } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { assetGrant, intrinsicSponsor, withOwnerDevice, type AssetDeps } from './assetAuthority.js'
import { withScopedAuthority } from './authority.js'
import { folderVersionInTransaction } from './admissions.js'
import { authNow } from '../auth/accounts.js'
const hidden = () => new AbeleError('not_found', 'no current intrinsic sponsor')
async function currentProof(
  tx: Transaction<Database>,
  deps: AssetDeps,
  vault: string,
  grant: string,
  file: string
) {
  if (!file || file.length > 200) throw hidden()
  const row = await tx
    .selectFrom('scope_current_members as note')
    .innerJoin('scope_admission_intervals as interval', 'interval.id', 'note.interval_id')
    .select(['note.file_id', 'note.version_id', 'interval.generation'])
    .where('note.vault_id', '=', vault)
    .where('note.grant_id', '=', grant)
    .where('note.file_id', '=', file)
    .where('note.kind', '=', 'note')
    .where('interval.intrinsic', '=', 1)
    .where('interval.ended_at', 'is', null)
    .executeTakeFirst()
  if (!row) throw hidden()
  const sponsor = {
    fileId: row.file_id,
    versionId: row.version_id,
    admissionGeneration: row.generation,
    inScope: true as const,
    intrinsic: true as const,
  }
  try {
    await intrinsicSponsor(tx, deps, grant, vault, sponsor)
  } catch (error) {
    if (error instanceof AbeleError && error.code === 'conflict') throw hidden()
    throw error
  }
  return IntrinsicSponsorProofSchema.parse({ grantId: grant, sponsor })
}
/** Exact current note/generation metadata only, never inventory/history/body discovery.
 * The two writes recheck the returned version and generation under their own fence.
 */
export async function readIntrinsicSponsorProof(
  deps: AssetDeps,
  token: string,
  vault: string,
  grant: string,
  file: string,
  expectedFacet?: 'owner' | 'scoped'
) {
  const facet = credentialFacet(token)
  if (
    (expectedFacet === 'owner' && facet !== 'device') ||
    (expectedFacet === 'scoped' && facet !== 'scoped')
  )
    throw new AbeleError('unauthorized', 'bound credential facet is required')
  if (facet === 'device')
    return withOwnerDevice(deps, token, vault, grant, async (tx, _device, row) => {
      if (row.state !== 'active') throw new AbeleError('scope_updating', 'grant view is preparing')
      return currentProof(tx, deps, vault, grant, file)
    })
  return withScopedAuthority(deps, token, vault, grant, 'read', async (tx, a) => {
    if (a.role !== 'editor') throw new AbeleError('forbidden', 'editor authority is required')
    await assetGrant(tx, deps, vault, grant)
    const proof = await currentProof(tx, deps, vault, grant, file)
    await folderVersionInTransaction(tx, a, file, proof.sponsor.versionId, authNow(deps), deps)
    return proof
  })
}
