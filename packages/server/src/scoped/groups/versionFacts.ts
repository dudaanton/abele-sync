import { AbeleError } from '@abele/sync-protocol'
import { createHash } from 'node:crypto'
import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { fileKind } from '../../oplog/kinds.js'
import { getVaultSettings } from '../../vault/vaults.js'
import type { ScopedUploadDeps } from '../uploads.js'
import { scopedSecurityEligibility } from '../folderSecurity.js'
import { parseGroupFrontmatter, type GroupFrontmatter } from './frontmatter.js'
import { reduceGroupOrigins, type GroupOriginState, type GroupWriter } from './origins.js'
import { storeGroupOrigins } from './originStore.js'
import { bindGroupToken, canonicalGroupToken, resolveGroupTarget } from './bindings.js'
import { readAudienceApproval } from './audienceApproval.js'
export type GroupFactDeps = ScopedUploadDeps & { parseGroups?: (text: string) => GroupFrontmatter }
export const groupUnavailable = () =>
  new AbeleError('scope_unavailable', 'group evidence unavailable; reviewed rebuild required')
const empty = (): GroupOriginState => ({ memory: {}, active: [], uncertain: false })
export async function groupStateFor(
  tx: Transaction<Database>,
  vaultId: string,
  fileId: string,
  versionId: string | null
): Promise<GroupOriginState | null> {
  if (!versionId) return null
  const fact = await tx
    .selectFrom('scope_group_parse_facts')
    .select('facts')
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', fileId)
    .where('version_id', '=', versionId)
    .executeTakeFirst()
  if (!fact) return null
  if (fact.facts.length > 1024 * 1024) throw groupUnavailable()
  return JSON.parse(fact.facts) as GroupOriginState
}
/** Shared ordered fact reducer for bootstrap and dirty replay; cached immutable
 * versions are never re-attributed from the current/final actor.
 */
export async function processGroupVersion(
  tx: Transaction<Database>,
  deps: GroupFactDeps,
  vaultId: string,
  fileId: string,
  versionId: string,
  at: string,
  complete = true
) {
  const existing = await groupStateFor(tx, vaultId, fileId, versionId)
  if (existing) return existing
  const version = await tx
    .selectFrom('versions')
    .selectAll()
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', fileId)
    .where('id', '=', versionId)
    .executeTakeFirst()
  if (!version) throw groupUnavailable()
  const security = await tx
    .selectFrom('version_security_sources')
    .selectAll()
    .where('vault_id', '=', vaultId)
    .where('version_id', '=', version.id)
    .executeTakeFirst()
  if (!security) {
    const previous = await groupStateFor(tx, vaultId, fileId, version.prev_version_id)
    const held: GroupOriginState = { memory: previous?.memory ?? {}, active: [], uncertain: true }
    await tx
      .insertInto('scope_group_parse_facts')
      .values({
        vault_id: vaultId,
        file_id: fileId,
        version_id: version.id,
        status: 'unknown',
        facts: JSON.stringify(held),
        committed_seq: version.seq,
        recorded_at: at,
      })
      .execute()
    return held
  }
  const owner = await tx
      .selectFrom('vaults')
      .select('owner_account_id')
      .where('id', '=', vaultId)
      .executeTakeFirstOrThrow(),
    settings = await getVaultSettings({ db: tx }, vaultId)
  const writer: GroupWriter = {
    facet:
      security.writer_facet === 'device' || security.writer_facet === 'scoped'
        ? security.writer_facet
        : 'unknown',
    principalId: security.writer_principal_id,
    accountId: security.writer_account_id,
    grantId: security.writer_grant_id,
  }
  const options = {
    configurationDirectories:
      deps.configurationDirectories ?? deps.config?.configurationDirectories,
  }
  const safe = scopedSecurityEligibility(
    { path: version.path, kind: fileKind(version.path, settings), security },
    options
  ).eligible
  const parse = async (
    sha: string | null,
    size: number
  ): Promise<GroupFrontmatter | { status: 'unknown'; groups: [] }> => {
    if (!sha) return { status: 'valid', groups: [] }
    if (size > 8 * 1024 * 1024) return { status: 'limited', groups: [] }
    const bytes = await deps.store.get(sha)
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha)
      throw groupUnavailable()
    return (deps.parseGroups ?? parseGroupFrontmatter)(bytes.toString('utf8'))
  }
  const parsed =
    safe && fileKind(version.path, settings) === 'note'
      ? await parse(version.blob_sha, version.size)
      : { status: 'unknown' as const, groups: [] }
  const tokens = parsed.groups
    .map((raw) => canonicalGroupToken(raw))
    .filter((token): token is NonNullable<typeof token> => token !== null)
  const status = tokens.length !== parsed.groups.length ? ('invalid' as const) : parsed.status
  let previous = await groupStateFor(tx, vaultId, fileId, version.prev_version_id)
  if (!previous && version.prev_version_id) previous = { ...empty(), uncertain: true }
  const ids: unknown = JSON.parse(security.source_version_ids)
  if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== 'string'))
    throw groupUnavailable()
  const sources: GroupOriginState[] = []
  for (const sourceId of ids as string[]) {
    const source = await tx
      .selectFrom('versions')
      .select(['file_id', 'id'])
      .where('vault_id', '=', vaultId)
      .where('id', '=', sourceId)
      .executeTakeFirst()
    const facts = source ? await groupStateFor(tx, vaultId, source.file_id, source.id) : null
    if (facts) sources.push(facts)
    else complete = false // Re-evaluate retained proof now; a commit-time lease is not eternal.
  }
  const attributed = async (
    values: Array<{ key: string; path: string }>,
    prior: GroupOriginState | null | undefined,
    lineage: GroupOriginState[]
  ) => {
    const result: Array<{ key: string; targetId: string | null }> = []
    for (const token of values) {
      const inherited =
        prior?.memory[token.key] ??
        lineage.flatMap((source) =>
          source.active.includes(token.key) && source.memory[token.key]
            ? [source.memory[token.key]!]
            : []
        )[0]
      result.push({
        key: token.key,
        targetId: inherited
          ? inherited.targetId
          : await resolveGroupTarget(tx, vaultId, token.path, options, version.seq),
      })
    }
    return result
  }
  if (version.merge) {
    const merge = JSON.parse(version.merge) as {
      incoming_sha: string
      base_version_id: string | null
    }
    const base = (await groupStateFor(tx, vaultId, fileId, merge.base_version_id)) ?? {
      ...empty(),
      uncertain: true,
    }
    const blob = await tx
      .selectFrom('blobs')
      .select('size')
      .where('sha', '=', merge.incoming_sha)
      .executeTakeFirst()
    const incoming = blob
      ? await parse(merge.incoming_sha, blob.size)
      : { status: 'unknown' as const, groups: [] }
    sources.push(
      reduceGroupOrigins({
        versionId: version.id,
        ownerAccountId: owner.owner_account_id,
        writer,
        operation: 'modify',
        status: incoming.status,
        tokens: await attributed(
          incoming.groups.flatMap((raw) => {
            const token = canonicalGroupToken(raw)
            return token ? [token] : []
          }),
          base,
          []
        ),
        previous: base,
      })
    )
  }
  if (sources.length > 8) {
    complete = false
    sources.splice(0, sources.length - 8)
  }
  let state = reduceGroupOrigins({
    versionId: version.id,
    ownerAccountId: owner.owner_account_id,
    writer,
    operation: version.op,
    status: complete ? status : 'unknown',
    tokens: await attributed(tokens, previous, sources),
    ...(previous ? { previous } : {}),
    sources,
  })
  state = await storeGroupOrigins(tx, vaultId, fileId, state, at)
  for (const token of tokens) {
    const edge = state.memory[token.key]
    if (!edge || !state.active.includes(token.key)) continue
    const binding = await bindGroupToken(
      tx,
      vaultId,
      fileId,
      token.key,
      edge.origin.id,
      token.path,
      options,
      version.seq,
      edge.bindingState ? { targetId: edge.targetId, state: edge.bindingState } : undefined
    )
    edge.targetId = binding.target_file_id
    edge.bindingState = binding.state
  }
  if (complete && status === 'valid' && version.op !== 'delete') {
    const approvals = await tx
      .selectFrom('scope_group_bindings')
      .select(['token_key', 'approved_rebind_id'])
      .where('vault_id', '=', vaultId)
      .where('source_file_id', '=', fileId)
      .where('approved_rebind_id', 'is not', null)
      .limit(1001)
      .execute()
    if (approvals.length > 1000) throw groupUnavailable()
    for (const approval of approvals)
      if (
        !state.active.includes(
          readAudienceApproval(approval.approved_rebind_id)?.tokenKey ?? approval.token_key
        )
      )
        await tx
          .updateTable('scope_group_bindings')
          .set({ approved_rebind_id: null })
          .where('vault_id', '=', vaultId)
          .where('source_file_id', '=', fileId)
          .where('token_key', '=', approval.token_key)
          .execute()
  }
  const encoded = JSON.stringify(state)
  if (Buffer.byteLength(encoded) > 1024 * 1024) throw groupUnavailable()
  await tx
    .insertInto('scope_group_parse_facts')
    .values({
      vault_id: vaultId,
      file_id: fileId,
      version_id: version.id,
      status: state.limited ? 'limited' : complete ? status : 'unknown',
      facts: encoded,
      committed_seq: version.seq,
      recorded_at: at,
    })
    .execute()
  return state
}
