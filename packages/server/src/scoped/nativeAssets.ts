import { z } from 'zod'
import { AbeleError, NativeSponsoredCreateSchema } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { withScopedAuthority } from './authority.js'
import { scopedUploadInTransaction, type ScopedUploadDeps } from './uploads.js'
import { intrinsicSponsor } from './assetAuthority.js'
import { commitScoped, type ScopedCommitDeps } from './commits.js'
const Proof = z
  .object({
    vault: z.string(),
    grant: z.string(),
    kind: z.enum(['key', 'installation']),
    principal: z.string(),
    sha: z.string(),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(200 * 1024 * 1024),
    created: z.string(),
    expires: z.string().nullable(),
  })
  .strict()
const endpoint = (deps: ScopedCommitDeps) =>
  deps.endpointIdentity ?? deps.config?.publicUrl ?? 'local'
const label = (deps: ScopedCommitDeps) => `v4-upload-proof:${endpoint(deps)}`
export async function readScopedUploadProof(
  deps: ScopedCommitDeps,
  token: string,
  vault: string,
  grant: string,
  sha: string
) {
  return withScopedAuthority(deps, token, vault, grant, 'stage', async (tx, a) => {
    const proof = await scopedUploadInTransaction(tx, a, sha, authNow(deps))
    const row = await tx
      .selectFrom('scope_blob_uploads')
      .select(['created_at', 'expires_at'])
      .where('vault_id', '=', vault)
      .where('grant_id', '=', grant)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('sha', '=', sha)
      .executeTakeFirstOrThrow()
    const value = Proof.parse({
      vault,
      grant,
      kind: a.principal.kind,
      principal: a.principal.principal_id,
      sha,
      size: proof.size,
      created: row.created_at,
      expires: row.expires_at,
    })
    return {
      sha,
      size: proof.size,
      entitlementId: deps.store
        .sealPart(Buffer.from(JSON.stringify(value)), label(deps))
        .toString('base64url'),
    }
  })
}
export async function createNativeSponsoredAsset(
  deps: ScopedCommitDeps,
  token: string,
  vault: string,
  grant: string,
  input: unknown
) {
  const body = NativeSponsoredCreateSchema.parse(input)
  const op = await withScopedAuthority(deps, token, vault, grant, 'receipt', async (tx, a) => {
    if (a.role !== 'editor') throw new AbeleError('forbidden', 'editor authority required')
    if (
      body.grantId !== grant ||
      body.upload.grantId !== grant ||
      body.upload.principalId !== a.principal.principal_id ||
      body.sha !== body.upload.sha
    )
      throw new AbeleError('not_found', 'no authorized upload proof')
    let parsed: z.SafeParseReturnType<unknown, z.infer<typeof Proof>> | undefined
    try {
      const bytes = deps.store.openPart(
        Buffer.from(body.upload.entitlementId, 'base64url'),
        label(deps)
      )
      if (bytes && bytes.length <= 2048) parsed = Proof.safeParse(JSON.parse(bytes.toString()))
    } catch {
      /* generic proof miss */
    }
    const receipt = await tx
      .selectFrom('scope_receipts')
      .select('request_id')
      .where('grant_id', '=', grant)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('request_id', '=', body.localCreateHandle)
      .where('endpoint_identity', '=', endpoint(deps))
      .executeTakeFirst()
    const row = await tx
      .selectFrom('scope_blob_uploads')
      .selectAll()
      .where('vault_id', '=', vault)
      .where('grant_id', '=', grant)
      .where('principal_kind', '=', a.principal.kind)
      .where('principal_id', '=', a.principal.principal_id)
      .where('sha', '=', body.sha)
      .where('expires_at', '>', authNow(deps).toISOString())
      .executeTakeFirst()
    if (
      !parsed?.success ||
      parsed.data.vault !== vault ||
      parsed.data.grant !== grant ||
      parsed.data.principal !== a.principal.principal_id ||
      parsed.data.kind !== a.principal.kind ||
      parsed.data.sha !== body.sha ||
      (!receipt &&
        (!row ||
          parsed.data.created !== row.created_at ||
          parsed.data.expires !== row.expires_at ||
          parsed.data.size !== row.size))
    )
      throw new AbeleError('not_found', 'no authorized upload proof')
    if (!receipt) await intrinsicSponsor(tx, deps, grant, vault, body.sponsor)
    return {
      proof: parsed.data,
      op: {
        op: 'create' as const,
        path: body.path,
        sha: body.sha,
        size: parsed.data.size,
        mtime: 0,
        sponsor_note_id: body.sponsor.fileId,
        sponsor_version_id: body.sponsor.versionId,
        sponsor_admission_generation: body.sponsor.admissionGeneration,
      },
    }
  })
  const outcome = await commitScoped(
      deps,
      token,
      vault,
      grant,
      body.localCreateHandle,
      [op.op],
      async (tx, a) => {
        const row = await tx
          .selectFrom('scope_blob_uploads')
          .select(['created_at', 'expires_at', 'size'])
          .where('vault_id', '=', vault)
          .where('grant_id', '=', grant)
          .where('principal_kind', '=', a.principal.kind)
          .where('principal_id', '=', a.principal.principal_id)
          .where('sha', '=', body.sha)
          .where('expires_at', '>', authNow(deps).toISOString())
          .executeTakeFirst()
        if (
          !row ||
          row.created_at !== op.proof.created ||
          row.expires_at !== op.proof.expires ||
          row.size !== op.proof.size
        )
          throw new AbeleError('not_found', 'no authorized upload proof')
      }
    ),
    first = outcome.results[0]
  if (outcome.acknowledged || !first || first.status === 'acknowledged')
    throw new AbeleError('scope_unavailable', 'native outcome needs reconciliation')
  return { fileId: first.file_id, versionId: first.version_id }
}
