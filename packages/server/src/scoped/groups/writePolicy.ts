import { AbeleError, caseKey } from '@abele/sync-protocol'
import { sql } from 'kysely'
import { parseDocument } from 'yaml'
import type { Transaction } from 'kysely'
import type { Database } from '../../db/schema.js'
import type { Ctx, NewVersion } from '../../oplog/commitCtx.js'
import type { ScopedAuthority } from '../authority.js'
import { folderVersionInTransaction } from '../admissions.js'
import { versionFolderFile } from '../admissionPolicy.js'
import { scopedSecurityEligibility, type SecurityOptions } from '../folderSecurity.js'
import { applyFolderAdmission } from '../admissionState.js'
import { parseGroupFrontmatter } from './frontmatter.js'
import { canonicalGroupToken } from './bindings.js'
import { reduceGroupOrigins } from './origins.js'
import { storeGroupOrigins } from './originStore.js'
import { newId } from '../../ids.js'
import { SCOPED_RESOURCE_LIMITS } from '../resourceLimits.js'
const forbidden = () =>
  new AbeleError('forbidden', 'existing group membership fields are protected')
export function groupKeys(bytes: Uint8Array): string[] {
  const parsed = parseGroupFrontmatter(Buffer.from(bytes).toString('utf8'))
  if (parsed.status !== 'valid') throw forbidden()
  const keys = parsed.groups.map((raw) => canonicalGroupToken(raw)?.key)
  if (keys.some((key) => !key)) throw forbidden()
  return (keys as string[]).sort()
}
export function protectGroupField(current: Uint8Array, incoming: Uint8Array) {
  if (JSON.stringify(groupKeys(current)) !== JSON.stringify(groupKeys(incoming))) throw forbidden()
}
export async function groupRootPath(
  tx: Transaction<Database>,
  a: ScopedAuthority,
  options: SecurityOptions = {}
) {
  if (a.selector.kind !== 'group') throw forbidden()
  const root = await tx
    .selectFrom('files')
    .select(['path', 'head_version_id'])
    .where('id', '=', a.selector.root_file_id)
    .where('vault_id', '=', a.principal.vault_id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  const source = root?.head_version_id
    ? await versionFolderFile(
        tx,
        a.principal.vault_id,
        a.selector.root_file_id,
        root.head_version_id
      )
    : null
  if (
    !root ||
    !source ||
    source.file.kind !== 'note' ||
    !scopedSecurityEligibility(source.file, options).eligible
  )
    throw forbidden()
  return root.path
}
export async function nativeGroupNote(
  ctx: Ctx,
  a: ScopedAuthority,
  bytes: Uint8Array
): Promise<Buffer> {
  const root = await groupRootPath(ctx.trx, a, {
      configurationDirectories: ctx.configurationDirectories,
    }),
    keys = groupKeys(bytes),
    key = caseKey(root)
  if (keys.length) {
    if (keys.length !== 1 || keys[0] !== key) throw forbidden()
    return Buffer.from(bytes)
  }
  const text = Buffer.from(bytes).toString(),
    match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match) {
    const doc = parseDocument(match[1]!)
    doc.set('groups', [`[[${root}]]`])
    return Buffer.from(`---\n${doc.toString()}---\n${text.slice(match[0].length)}`)
  }
  return Buffer.from(`---\ngroups: ${JSON.stringify([`[[${root}]]`])}\n---\n${text}`)
}
/** Authorize a sponsor only from independent intrinsic note admission. */
export async function groupSponsor(ctx: Ctx, a: ScopedAuthority, id: string) {
  const note = await ctx.trx
    .selectFrom('scope_current_members as note')
    .innerJoin('scope_admission_intervals as interval', 'interval.id', 'note.interval_id')
    .select(['note.file_id', 'note.version_id', 'note.interval_id', 'interval.generation'])
    .where('note.grant_id', '=', a.principal.grant_id)
    .where('note.vault_id', '=', ctx.vaultId)
    .where('note.file_id', '=', id)
    .where('note.kind', '=', 'note')
    .where('interval.intrinsic', '=', 1)
    .where('interval.ended_at', 'is', null)
    .executeTakeFirst()
  if (!note) throw new AbeleError('not_found', 'no authorized native sponsor')
  await folderVersionInTransaction(ctx.trx, a, id, note.version_id, ctx.at, {
    configurationDirectories: ctx.configurationDirectories,
  })
  return note
}
export async function currentGroupBytes(
  ctx: Ctx,
  a: ScopedAuthority,
  fileId: string,
  sha: string | null
) {
  if (sha !== null) return ctx.store.get(sha)
  const trash = await ctx.trx
    .selectFrom('scope_trash')
    .select('last_version_id')
    .where('grant_id', '=', a.principal.grant_id)
    .where('file_id', '=', fileId)
    .where('eligible', '=', 1)
    .where('expires_at', '>', ctx.at.toISOString())
    .executeTakeFirst()
  const version = trash
    ? await ctx.trx
        .selectFrom('versions')
        .select('blob_sha')
        .where('id', '=', trash.last_version_id)
        .where('vault_id', '=', ctx.vaultId)
        .where('file_id', '=', fileId)
        .executeTakeFirst()
    : undefined
  if (!version?.blob_sha) throw forbidden()
  return ctx.store.get(version.blob_sha)
}
/** Snapshot first introducer and root identity inside the scoped creation fence;
 * worker replay must not resolve its old root spelling against a future identity.
 */
export async function admitGroupOutput(
  ctx: Ctx,
  a: ScopedAuthority,
  v: NewVersion,
  versionId: string,
  sponsorId?: string
) {
  const kind = v.path.toLowerCase().endsWith('.md')
    ? 'note'
    : v.path.toLowerCase().endsWith('.canvas')
      ? 'canvas'
      : 'attachment'
  const prior = await ctx.trx
    .selectFrom('scope_current_members as member')
    .innerJoin('scope_admission_intervals as interval', 'interval.id', 'member.interval_id')
    .select('interval.intrinsic')
    .where('member.grant_id', '=', a.principal.grant_id)
    .where('member.file_id', '=', v.fileId)
    .where('interval.ended_at', 'is', null)
    .executeTakeFirst()
  // Extension is a security classification, never independent membership proof.
  // Extra-only identities stay extra-only across rename, including inside a unit.
  const deletedProof =
    !prior && v.prevVersionId
      ? await ctx.trx
          .selectFrom('scope_trash as trash')
          .innerJoin('scope_admission_intervals as interval', 'interval.id', 'trash.interval_id')
          .select('interval.intrinsic')
          .where('trash.grant_id', '=', a.principal.grant_id)
          .where('trash.file_id', '=', v.fileId)
          .where('trash.deleted_version_id', '=', v.prevVersionId)
          .where('trash.eligible', '=', 1)
          .where('trash.expires_at', '>', ctx.at.toISOString())
          .executeTakeFirst()
      : undefined
  let intrinsic = kind === 'note' && (prior?.intrinsic === 1 || deletedProof?.intrinsic === 1)
  if (v.no === 1) {
    if (kind === 'note') {
      if (!v.sha || a.selector.kind !== 'group') throw forbidden()
      const root = await groupRootPath(ctx.trx, a, {
          configurationDirectories: ctx.configurationDirectories,
        }),
        keys = groupKeys(await ctx.store.get(v.sha))
      if (keys.length !== 1 || keys[0] !== caseKey(root)) throw forbidden()
      intrinsic = true
      let state = reduceGroupOrigins({
        versionId,
        ownerAccountId: a.ownerAccountId,
        writer: {
          facet: 'scoped',
          principalId: a.principal.principal_id,
          accountId: a.principal.account_id,
          grantId: a.principal.grant_id,
        },
        operation: 'create',
        status: 'valid',
        tokens: [{ key: keys[0], targetId: a.selector.root_file_id }],
        nativeRoot: {
          key: keys[0],
          targetId: a.selector.root_file_id,
          grantId: a.principal.grant_id,
        },
      })
      state = await storeGroupOrigins(ctx.trx, ctx.vaultId, v.fileId, state, ctx.at.toISOString())
      state.memory[keys[0]!]!.bindingState = 'bound'
      await ctx.trx
        .insertInto('scope_group_bindings')
        .values({
          vault_id: ctx.vaultId,
          source_file_id: v.fileId,
          token_key: keys[0]!,
          origin_id: state.memory[keys[0]!]!.origin.id,
          target_file_id: a.selector.root_file_id,
          state: 'bound',
          approved_rebind_id: null,
        })
        .execute()
      const row = await ctx.trx
        .selectFrom('versions')
        .select('seq')
        .where('id', '=', versionId)
        .executeTakeFirstOrThrow()
      await ctx.trx
        .insertInto('scope_group_parse_facts')
        .values({
          vault_id: ctx.vaultId,
          file_id: v.fileId,
          version_id: versionId,
          status: 'valid',
          facts: JSON.stringify(state),
          committed_seq: row.seq,
          recorded_at: ctx.at.toISOString(),
        })
        .execute()
    } else {
      if (!sponsorId)
        throw new AbeleError('forbidden', 'a native attachment requires an intrinsic sponsor')
      const count = await ctx.trx
        .selectFrom('scope_extra_entries')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('grant_id', '=', a.principal.grant_id)
        .where('withdrawn_at', 'is', null)
        .executeTakeFirst()
      if (Number(count?.count ?? 0) >= SCOPED_RESOURCE_LIMITS.liveExtraEntries)
        throw new AbeleError('too_large', 'asset entry bound reached')
      const sponsor = await groupSponsor(ctx, a, sponsorId),
        entryId = newId()
      await ctx.trx
        .insertInto('scope_extra_entries')
        .values({
          id: entryId,
          grant_id: a.principal.grant_id,
          vault_id: ctx.vaultId,
          file_id: v.fileId,
          origin: 'native',
          first_version_id: versionId,
          generation: 1,
          owner_device_id: null,
          reason: 'native_create',
          created_at: ctx.at.toISOString(),
          withdrawn_at: null,
        })
        .execute()
      await ctx.trx
        .insertInto('scope_extra_sponsors')
        .values({
          entry_id: entryId,
          grant_id: a.principal.grant_id,
          vault_id: ctx.vaultId,
          note_id: sponsor.file_id,
          interval_id: sponsor.interval_id,
          admission_generation: sponsor.generation,
          intrinsic: 1,
          added_at: ctx.at.toISOString(),
        })
        .execute()
      await ctx.trx
        .updateTable('scope_grants')
        .set({ publication_revision: sql<number>`publication_revision + 1` })
        .where('id', '=', a.principal.grant_id)
        .execute()
    }
  }
  const security = await ctx.trx
    .selectFrom('version_security_sources')
    .selectAll()
    .where('version_id', '=', versionId)
    .executeTakeFirstOrThrow()
  await applyFolderAdmission(
    ctx.trx,
    { id: a.principal.grant_id, folder_prefix: a.selector.kind === 'folder' ? a.prefix : null },
    {
      id: v.fileId,
      vault_id: ctx.vaultId,
      path: v.path,
      kind,
      security,
      versionId,
      sha: v.sha,
      size: v.size,
      mtime: v.mtime,
      deleted: v.op === 'delete',
    },
    ctx.at,
    { configurationDirectories: ctx.configurationDirectories },
    a.selector.kind === 'group' ? { eligible: true, intrinsic } : undefined
  )
}
