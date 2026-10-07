import { AbeleError, ShaSchema } from '@abele/sync-protocol'
import type { CommitOp } from '@abele/sync-protocol'
import { authNow } from '../auth/accounts.js'
import { getVaultSettings } from '../vault/vaults.js'
import { mergeText } from '../merge/index.js'
import { decide } from '../oplog/resolve.js'
import type { LoadedHead } from '../oplog/commitCtx.js'
import type { Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { withScopedAuthority, type ScopedAuthority } from './authority.js'
import { folderVersionInTransaction } from './admissions.js'
import { scopedUploadInTransaction, type ScopedUploadDeps } from './uploads.js'
import { namespaceIsRestricted, sourceNamespaces } from './folderSecurity.js'
import type { AdmissionOptions } from './admissionPolicy.js'

export type ScopedModify = Extract<CommitOp, { op: 'modify' }>
export type ScopedMergeInputDeps = ScopedUploadDeps & AdmissionOptions
const missing = () => new AbeleError('not_found', 'authorized commit input is unavailable')
const MAX_NOTE_BYTES = 8 * 1024 * 1024
/** Bounded, read-only input adapter around the personal pure decision algorithm.
 * No unrestricted loadHead, cross-vault SHA ownership, private history deduplication,
 * write or receipt can be reached through this preparation path. Output authorization
 * and atomic publication are separate from this input adapter.
 */
export async function prepareScopedModify(
  deps: ScopedMergeInputDeps,
  token: string,
  vaultId: string,
  grantId: string,
  input: Omit<ScopedModify, 'op'>
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'write', async (tx, a) => {
    const { head, decision, baseVersion, current } = await loadScopedModify(tx, a, deps, input)
    if (decision.kind !== 'merge')
      return { decision: decision.kind, path: current.path, base_version_id: input.base_version_id }
    if (
      current.kind !== 'note' ||
      input.size > MAX_NOTE_BYTES ||
      current.size > MAX_NOTE_BYTES ||
      (baseVersion?.size ?? 0) > MAX_NOTE_BYTES
    )
      throw new AbeleError('too_large', 'scoped note preparation bound reached')
    const read = async (sha: string | null, size: number) => {
      if (!sha) return ''
      try {
        const bytes = await deps.store.get(sha)
        if (bytes.length !== size) throw missing()
        return bytes.toString('utf8')
      } catch {
        throw missing()
      }
    }
    const [baseText, headText, incoming] = await Promise.all([
      read(head.baseSha, baseVersion?.size ?? 0),
      read(current.sha, current.size),
      read(input.sha, input.size),
    ])
    const merged = mergeText(baseText, headText, incoming)
    return {
      decision: 'merge' as const,
      path: current.path,
      base_version_id: input.base_version_id,
      text: merged.text,
      clean: merged.clean,
      conflictCopy: merged.conflictCopy === true,
    }
  })
}

/** Same input proof, reused inside the publication transaction rather than nested locks. */
export async function loadScopedModify(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  deps: ScopedMergeInputDeps,
  input: Omit<ScopedModify, 'op'>
) {
  const vaultId = a.principal.vault_id,
    grantId = a.principal.grant_id
  if (
    !input.file_id ||
    !input.base_version_id ||
    !ShaSchema.safeParse(input.sha).success ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !Number.isSafeInteger(input.mtime) ||
    input.mtime < 0
  )
    throw new AbeleError('invalid_request', 'invalid scoped modify')
  const current = await tx
    .selectFrom('scope_current_members')
    .selectAll()
    .where('grant_id', '=', grantId)
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', input.file_id)
    .executeTakeFirst()
  if (!current || current.sha === null) throw missing()
  try {
    await folderVersionInTransaction(tx, a, input.file_id, current.version_id, authNow(deps), deps)
  } catch {
    throw missing()
  }
  // Base membership is checked before any incoming blob/metadata is read. A private
  // base and a fabricated/pruned-without-proof ID give the same generic miss.
  const evidence = await tx
    .selectFrom('scope_version_admissions')
    .select('version_id')
    .where('grant_id', '=', grantId)
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', input.file_id)
    .where('interval_id', '=', current.interval_id)
    .where('version_id', '=', input.base_version_id)
    .executeTakeFirst()
  if (!evidence) throw missing()
  const baseVersion = await tx
    .selectFrom('versions')
    .select(['blob_sha', 'path', 'size', 'mtime'])
    .where('id', '=', input.base_version_id)
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', input.file_id)
    .executeTakeFirst()
  if (baseVersion) {
    try {
      const base = await folderVersionInTransaction(
        tx,
        a,
        input.file_id,
        input.base_version_id,
        authNow(deps),
        deps
      )
      if (base.interval_id !== current.interval_id) throw missing()
    } catch {
      throw missing()
    }
  } else {
    // Pruned payload is the personal empty-base fallback only with retained
    // current-interval admission AND complete file-local negative security facts.
    const facts = await tx
      .selectFrom('version_security_sources')
      .select(['executable', 'settings', 'source_namespaces'])
      .where('vault_id', '=', vaultId)
      .where('file_id', '=', input.file_id)
      .where('version_id', '=', input.base_version_id)
      .executeTakeFirst()
    const roots = sourceNamespaces(facts?.source_namespaces)
    if (
      !facts ||
      facts.executable !== 0 ||
      facts.settings !== 0 ||
      !roots ||
      namespaceIsRestricted(roots, {
        configurationDirectories:
          deps.configurationDirectories ?? deps.config?.configurationDirectories,
      })
    )
      throw missing()
  }
  const headVersion = await tx
    .selectFrom('versions')
    .select(['no', 'seq', 'blob_sha', 'size', 'mtime'])
    .where('id', '=', current.version_id)
    .where('vault_id', '=', vaultId)
    .where('file_id', '=', input.file_id)
    .executeTakeFirst()
  if (!headVersion || headVersion.blob_sha !== current.sha) throw missing()
  const candidate = await tx
    .selectFrom('scope_version_admissions as admitted')
    .innerJoin('versions as version', 'version.id', 'admitted.version_id')
    .select(['version.id', 'version.size'])
    .where('admitted.grant_id', '=', grantId)
    .where('admitted.vault_id', '=', vaultId)
    .where('admitted.file_id', '=', input.file_id)
    .where('admitted.interval_id', '=', current.interval_id)
    .where('version.blob_sha', '=', input.sha)
    .limit(1)
    .executeTakeFirst()
  let already = false
  if (candidate) {
    try {
      const admitted = await folderVersionInTransaction(
        tx,
        a,
        input.file_id,
        candidate.id,
        authNow(deps),
        deps
      )
      already = admitted.interval_id === current.interval_id && candidate.size === input.size
    } catch {
      /* A stale or restricted admission confers no blob entitlement. */
    }
  }
  if (input.sha !== current.sha && !already) {
    try {
      const proof = await scopedUploadInTransaction(tx, a, input.sha, authNow(deps))
      if (proof.size !== input.size) throw missing()
    } catch {
      throw missing()
    }
  }
  if (input.sha === current.sha && input.size !== headVersion.size)
    throw new AbeleError('invalid_request', 'invalid content size')
  const head: LoadedHead = {
    seq: headVersion.seq,
    fileId: input.file_id,
    path: current.path,
    kind: current.kind,
    deleted: false,
    versionId: current.version_id,
    sha: current.sha,
    size: headVersion.size,
    mtime: headVersion.mtime,
    no: headVersion.no,
    baseIsKnown: baseVersion ? 'yes' : 'unknown',
    baseSha: baseVersion?.blob_sha ?? null,
    basePath: baseVersion?.path ?? null,
    ...(baseVersion ? { baseSize: baseVersion.size, baseMtime: baseVersion.mtime } : {}),
    incoming: already ? 'version' : null,
    incomingVersion: already,
  }
  const op: ScopedModify = { op: 'modify', ...input }
  const settings = await getVaultSettings({ db: tx }, vaultId)
  const decision = decide(op, head, settings, false)
  if (decision.kind === 'reject')
    throw new AbeleError('invalid_request', 'scoped edit cannot be prepared')
  return { head, op, decision, settings, baseVersion, current }
}
