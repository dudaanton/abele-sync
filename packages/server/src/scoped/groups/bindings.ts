import { AbeleError, caseKey, normalisePath, validatePath } from '@abele/sync-protocol'
import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import { versionFolderFile } from '../admissionPolicy.js'
import { scopedSecurityEligibility, type SecurityOptions } from '../folderSecurity.js'
import { headAtStart } from '../folderPreparation.js'
export function canonicalGroupToken(raw: string): { key: string; path: string } | null {
  if (raw.length > 1024) return null
  let path = raw.trim()
  if (path.startsWith('[[') && path.endsWith(']]')) path = path.slice(2, -2)
  path = path.split('|')[0]!.split('#')[0]!.trim()
  if (!/\.md$/i.test(path)) path += '.md'
  try {
    validatePath(path)
    if (normalisePath(path) !== path) return null
  } catch {
    return null
  }
  return { key: caseKey(path), path }
}
/** Existing unresolved/tombstoned bindings do not perform resolution again.
 * Fresh canonical tokens query only one exact path, never whole-vault basenames.
 */
export async function resolveGroupTarget(
  tx: Transaction<Database>,
  vaultId: string,
  raw: string,
  options: SecurityOptions = {},
  introducedSeq?: number
): Promise<string | null> {
  const token = canonicalGroupToken(raw)
  if (!token) return null
  const targets = token
    ? await tx
        .selectFrom('files')
        .innerJoin('versions as head', 'head.id', 'files.head_version_id')
        .select(['files.id', 'head_version_id', 'kind', 'head.seq'])
        .where('files.vault_id', '=', vaultId)
        .where('files.path_ci', '=', caseKey(token.path))
        .where('deleted_at', 'is', null)
        .limit(2)
        .execute()
    : []
  const candidateIds = new Set(targets.map((target) => target.id))
  if (introducedSeq !== undefined) {
    // A lagged worker may first see this spelling only after rename. Restrict
    // discovery to exact retained historical path candidates, never basenames;
    // each candidate must still prove its actual head at introduction time.
    const missing = await tx
      .selectFrom('versions')
      .select('id')
      .where('vault_id', '=', vaultId)
      .where('seq', '<=', introducedSeq)
      .where('path_ci', 'is', null)
      .limit(1)
      .executeTakeFirst()
    if (missing)
      throw new AbeleError('scope_unavailable', 'historical path proof requires recovery')
    const historical = await tx
      .selectFrom('versions')
      .select('file_id')
      .where('vault_id', '=', vaultId)
      .where('seq', '<=', introducedSeq)
      .where('path_ci', '=', caseKey(token.path))
      .groupBy('file_id')
      .limit(65)
      .execute()
    if (historical.length > 64)
      throw new AbeleError('scope_unavailable', 'historical target candidate proof bound reached')
    for (const row of historical) candidateIds.add(row.file_id)
  }
  const proven: string[] = []
  for (const id of candidateIds) {
    const candidate = await tx
      .selectFrom('files')
      .select(['id', 'kind', 'head_version_id'])
      .where('vault_id', '=', vaultId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!candidate || candidate.kind !== 'note' || !candidate.head_version_id) continue
    if (introducedSeq !== undefined) {
      // Prove the actual historical head, not today's version number and not the
      // newest surviving path match. Body edits do not change target identity.
      // Exhausted/pruned/cyclic history is unknown proof, never proven absence.
      // Propagate it so the worker holds instead of minting a new owner edge.
      {
        const historical = await headAtStart(
          tx,
          vaultId,
          { id: candidate.id, head_version_id: candidate.head_version_id },
          introducedSeq
        )
        if (
          !historical ||
          historical.op === 'delete' ||
          caseKey(historical.path) !== caseKey(token!.path)
        )
          continue
      }
    }
    const target = await versionFolderFile(tx, vaultId, candidate.id, candidate.head_version_id!)
    if (target && scopedSecurityEligibility(target.file, options).eligible)
      proven.push(candidate.id)
  }
  if (proven.length > 1)
    throw new AbeleError('scope_unavailable', 'ambiguous historical target proof')
  if (proven.length === 0 && introducedSeq !== undefined) {
    // A missing path candidate is not proven absence if GC removed any earlier
    // version. The vault sequence is contiguous before retention, so a count
    // mismatch conservatively holds instead of losing first-introducer identity.
    const history = await tx
      .selectFrom('versions')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('vault_id', '=', vaultId)
      .where('seq', '<=', introducedSeq)
      .executeTakeFirstOrThrow()
    if (Number(history.count) !== introducedSeq)
      throw new AbeleError('scope_unavailable', 'historical target absence proof was pruned')
  }
  return proven.length === 1 ? proven[0]! : null
}
export async function bindGroupToken(
  tx: Transaction<Database>,
  vaultId: string,
  sourceId: string,
  key: string,
  originId: string,
  raw: string,
  options: SecurityOptions = {},
  introducedSeq?: number,
  inherited?: { targetId: string | null; state: 'bound' | 'unresolved' | 'tombstoned' }
) {
  const existing = await tx
    .selectFrom('scope_group_bindings')
    .selectAll()
    .where('vault_id', '=', vaultId)
    .where('source_file_id', '=', sourceId)
    .where('token_key', '=', key)
    .executeTakeFirst()
  if (existing) {
    if (existing.state === 'bound') {
      const target = await tx
        .selectFrom('files')
        .select(['id', 'deleted_at'])
        .where('vault_id', '=', vaultId)
        .where('id', '=', existing.target_file_id!)
        .executeTakeFirst()
      if (!target || target.deleted_at !== null) {
        await tx
          .updateTable('scope_group_bindings')
          .set({ state: 'tombstoned' })
          .where('vault_id', '=', vaultId)
          .where('source_file_id', '=', sourceId)
          .where('token_key', '=', key)
          .execute()
        return { ...existing, state: 'tombstoned' as const }
      }
    }
    return existing
  }
  const targetId = inherited
    ? inherited.targetId
    : await resolveGroupTarget(tx, vaultId, raw, options, introducedSeq)
  let state: 'bound' | 'unresolved' | 'tombstoned' =
    inherited?.state ?? (targetId === null ? 'unresolved' : 'bound')
  if (inherited && state === 'bound' && targetId !== null) {
    const target = await tx
      .selectFrom('files')
      .select('deleted_at')
      .where('vault_id', '=', vaultId)
      .where('id', '=', targetId)
      .executeTakeFirst()
    if (!target || target.deleted_at !== null) state = 'tombstoned'
  }
  const binding = {
    vault_id: vaultId,
    source_file_id: sourceId,
    token_key: key,
    origin_id: originId,
    target_file_id: targetId,
    state,
    approved_rebind_id: null,
  }
  await tx.insertInto('scope_group_bindings').values(binding).execute()
  return binding
}
export interface AnchoredClosureInput {
  grantId: string
  rootId: string
  approvedAnchors: ReadonlySet<string>
  eligibleFiles: ReadonlySet<string>
  edges: readonly { source: string; target: string; kind: string; originGrant: string | null }[]
  maxNodes?: number
  maxEdges?: number
}
/** Reverse bound-target traversal. A member is not an authority anchor merely
 * because its name is linked later or the owner re-saves its body.
 */
export function anchoredGroupClosure(input: AnchoredClosureInput): Set<string> {
  const maxNodes = input.maxNodes ?? 100000,
    maxEdges = input.maxEdges ?? 200000
  if (input.edges.length > maxEdges) throw new Error('group traversal edge bound reached')
  const members = new Set<string>()
  if (!input.eligibleFiles.has(input.rootId) || !input.approvedAnchors.has(input.rootId))
    return members
  const reverse = new Map<string, string[]>()
  for (const edge of input.edges)
    if (
      edge.kind === 'owner_personal' ||
      (edge.kind === 'grant_native' && edge.originGrant === input.grantId)
    ) {
      const values = reverse.get(edge.target) ?? []
      values.push(edge.source)
      reverse.set(edge.target, values)
    }
  const queue = [input.rootId],
    seen = new Set<string>()
  members.add(input.rootId)
  for (let index = 0; index < queue.length; index++) {
    const anchor = queue[index]!
    if (seen.has(anchor)) continue
    seen.add(anchor)
    for (const source of reverse.get(anchor) ?? []) {
      if (!input.eligibleFiles.has(source)) continue
      members.add(source)
      if (members.size > maxNodes) throw new Error('group traversal node bound reached')
      if (input.approvedAnchors.has(source) && !seen.has(source)) queue.push(source)
    }
  }
  return members
}
