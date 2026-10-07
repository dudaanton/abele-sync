import { createHash } from 'node:crypto'
import {
  AbeleError,
  OwnerAssetAddSchema,
  AssetMutationSchema,
  credentialFacet,
} from '@abele/sync-protocol'
import { sql, type Transaction } from 'kysely'
import type { Database } from '../db/schema.js'
import { newId } from '../ids.js'
import { authNow } from '../auth/accounts.js'
import { authenticateDevice } from '../auth/devices.js'
import { withScopedAuthority } from './authority.js'
import { versionFolderFile } from './admissionPolicy.js'
import { scopedSecurityEligibility } from './folderSecurity.js'
import { applyFolderAdmission } from './admissionState.js'
import {
  assetView,
  withOwnerDevice,
  intrinsicSponsor,
  publicationGeneration,
  type AssetDeps,
} from './assetAuthority.js'
const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
export async function readSponsoredAssets(
  deps: AssetDeps,
  token: string,
  vault: string,
  grant: string
) {
  if (credentialFacet(token) === 'device')
    return withOwnerDevice(deps, token, vault, grant, (tx) => assetView(tx, deps, vault, grant))
  return withScopedAuthority(deps, token, vault, grant, 'read', (tx, a) =>
    assetView(tx, deps, vault, grant, true, a.role)
  )
}
async function replay(
  tx: Transaction<Database>,
  grant: string,
  device: string,
  intent: string,
  requestHash: string
) {
  const prior = await tx
    .selectFrom('scope_publication_outcomes')
    .select('request_hash')
    .where('grant_id', '=', grant)
    .where('owner_device_id', '=', device)
    .where('intent_id', '=', intent)
    .executeTakeFirst()
  if (prior && prior.request_hash !== requestHash)
    throw new AbeleError('idempotency_mismatch', 'publication intent changed')
  return !!prior
}
async function outcome(
  tx: Transaction<Database>,
  grant: string,
  device: string,
  intent: string,
  requestHash: string,
  revision: number,
  generation: number,
  at: Date
) {
  await tx
    .insertInto('scope_publication_outcomes')
    .values({
      grant_id: grant,
      owner_device_id: device,
      intent_id: intent,
      request_hash: requestHash,
      publication_revision: revision,
      withdrawal_generation: generation,
      outcome: null,
      created_at: at.toISOString(),
      payload_expires_at: new Date(at.getTime() + 600000).toISOString(),
    })
    .execute()
}
async function reconcile(
  tx: Transaction<Database>,
  deps: AssetDeps,
  grant: { id: string; folder_prefix: string | null },
  vault: string,
  fileId: string,
  eligible?: boolean
) {
  const file = await tx
    .selectFrom('files')
    .select('head_version_id')
    .where('id', '=', fileId)
    .where('vault_id', '=', vault)
    .executeTakeFirst()
  const source = file?.head_version_id
    ? await versionFolderFile(tx, vault, fileId, file.head_version_id)
    : null
  const independent =
    grant.folder_prefix === null
      ? await tx
          .selectFrom('scope_current_members as member')
          .innerJoin('scope_admission_intervals as interval', 'interval.id', 'member.interval_id')
          .select('member.file_id')
          .where('member.grant_id', '=', grant.id)
          .where('member.file_id', '=', fileId)
          .where('interval.intrinsic', '=', 1)
          .where('interval.ended_at', 'is', null)
          .executeTakeFirst()
      : undefined
  if (source)
    await applyFolderAdmission(
      tx,
      grant,
      {
        ...source.file,
        versionId: source.version.id,
        sha: source.version.blob_sha,
        size: source.version.size,
        mtime: source.version.mtime,
        deleted: source.version.op === 'delete',
      },
      authNow(deps),
      {
        configurationDirectories:
          deps.configurationDirectories ?? deps.config?.configurationDirectories,
      },
      grant.folder_prefix === null
        ? { eligible: !!independent || (eligible ?? false), intrinsic: !!independent }
        : undefined
    )
}
export async function addSponsoredAsset(
  deps: AssetDeps,
  token: string,
  vault: string,
  grant: string,
  input: unknown,
  deltaRequestHash?: string
) {
  const body = OwnerAssetAddSchema.parse(input)
  return withOwnerDevice(deps, token, vault, grant, async (tx, device, row) => {
    if (body.grantId !== grant || body.decisionDeviceId !== device.deviceId)
      throw new AbeleError('forbidden', 'same owner device decision required')
    const requestHash = deltaRequestHash ?? hash(body)
    if (await replay(tx, grant, device.deviceId, body.intentId, requestHash))
      return assetView(tx, deps, vault, grant)
    const generation = await publicationGeneration(tx, grant)
    if (
      row.state !== 'active' ||
      row.publication_revision !== body.expectedRevision ||
      generation !== body.withdrawalGeneration
    )
      throw new AbeleError('conflict', 'publication preview changed')
    const file = await tx
      .selectFrom('files')
      .select(['head_version_id', 'deleted_at', 'path'])
      .where('vault_id', '=', vault)
      .where('id', '=', body.target.fileId)
      .executeTakeFirst()
    const source = file?.head_version_id
      ? await versionFolderFile(tx, vault, body.target.fileId, file.head_version_id)
      : null
    if (
      !file ||
      file.deleted_at !== null ||
      !source ||
      file.head_version_id !== body.target.versionId ||
      source.version.blob_sha !== body.target.sha ||
      file.path !== body.target.path
    )
      throw new AbeleError('conflict', 'target preview changed')
    if (
      !scopedSecurityEligibility(source.file, {
        configurationDirectories:
          deps.configurationDirectories ?? deps.config?.configurationDirectories,
      }).eligible
    )
      throw new AbeleError('settings_forbidden', 'target is not eligible')
    if (body.reason === 'new-local') {
      const writer = await tx
        .selectFrom('version_security_sources')
        .selectAll()
        .where('version_id', '=', source.version.id)
        .executeTakeFirst()
      if (
        source.version.op !== 'create' ||
        source.version.no !== 1 ||
        writer?.writer_facet !== 'device' ||
        writer.writer_principal_id !== device.deviceId
      )
        throw new AbeleError('conflict', 'local creation proof changed')
    }
    if (new Set(body.sponsors.map((s) => s.fileId)).size !== body.sponsors.length)
      throw new AbeleError('invalid_request', 'duplicate sponsor')
    const sponsors = []
    for (const sponsor of body.sponsors)
      sponsors.push(await intrinsicSponsor(tx, deps, grant, vault, sponsor))
    const old = await tx
      .selectFrom('scope_extra_entries')
      .selectAll()
      .where('grant_id', '=', grant)
      .where('file_id', '=', body.target.fileId)
      .executeTakeFirst()
    const count = await tx
      .selectFrom('scope_extra_entries')
      .select('id')
      .where('grant_id', '=', grant)
      .where('withdrawn_at', 'is', null)
      .limit(1000)
      .execute()
    if (!old && count.length >= 1000) throw new AbeleError('too_large', 'asset list budget reached')
    const entryId = old?.id ?? newId(),
      at = authNow(deps)
    if (old)
      await tx
        .updateTable('scope_extra_entries')
        .set({
          withdrawn_at: null,
          generation: old.generation + (old.withdrawn_at ? 1 : 0),
          first_version_id: source.version.id,
          owner_device_id: device.deviceId,
          reason:
            body.reason === 'initial-batch'
              ? 'initial_batch'
              : body.reason === 'new-local'
                ? 'new_local_file'
                : 'confirmed_existing_file',
        })
        .where('id', '=', entryId)
        .execute()
    else
      await tx
        .insertInto('scope_extra_entries')
        .values({
          id: entryId,
          grant_id: grant,
          vault_id: vault,
          file_id: body.target.fileId,
          origin: 'owner',
          first_version_id: source.version.id,
          generation: 1,
          owner_device_id: device.deviceId,
          reason:
            body.reason === 'initial-batch'
              ? 'initial_batch'
              : body.reason === 'new-local'
                ? 'new_local_file'
                : 'confirmed_existing_file',
          created_at: at.toISOString(),
          withdrawn_at: null,
        })
        .execute()
    for (const sponsor of sponsors)
      await tx
        .insertInto('scope_extra_sponsors')
        .values({
          entry_id: entryId,
          grant_id: grant,
          vault_id: vault,
          note_id: sponsor.file_id,
          interval_id: sponsor.interval_id,
          admission_generation: sponsor.generation,
          intrinsic: 1,
          added_at: at.toISOString(),
        })
        .onConflict((oc) => oc.columns(['entry_id', 'note_id']).doNothing())
        .execute()
    await reconcile(tx, deps, row, vault, body.target.fileId, true)
    await tx
      .updateTable('scope_grants')
      .set({ publication_revision: sql<number>`publication_revision + 1` })
      .where('id', '=', grant)
      .execute()
    await outcome(
      tx,
      grant,
      device.deviceId,
      body.intentId,
      requestHash,
      row.publication_revision + 1,
      generation,
      at
    )
    return assetView(tx, deps, vault, grant)
  })
}
export async function mutateSponsoredAssets(
  deps: AssetDeps,
  token: string,
  vault: string,
  grant: string,
  input: unknown
) {
  const body = AssetMutationSchema.parse(input)
  if (body.delta.kind === 'add') {
    const device = await authenticateDevice(deps, token),
      view = await readSponsoredAssets(deps, token, vault, grant)
    return addSponsoredAsset(
      deps,
      token,
      vault,
      grant,
      {
        grantId: grant,
        expectedRevision: body.expectedRevision,
        withdrawalGeneration: body.withdrawalGeneration ?? view.withdrawalGeneration,
        intentId: body.intentId,
        decisionDeviceId: body.decisionDeviceId ?? device.deviceId,
        target: body.delta.entry.target,
        sponsors: body.delta.entry.sponsors,
        reason: body.delta.entry.reason,
      },
      hash(body)
    )
  }
  return withOwnerDevice(deps, token, vault, grant, async (tx, device, row) => {
    const requestHash = hash(body)
    if (await replay(tx, grant, device.deviceId, body.intentId, requestHash))
      return assetView(tx, deps, vault, grant)
    const generation = await publicationGeneration(tx, grant),
      at = authNow(deps)
    if (
      row.state !== 'active' ||
      row.publication_revision !== body.expectedRevision ||
      (body.delta.kind === 'withdraw' && body.delta.expectedGeneration !== generation)
    )
      throw new AbeleError('conflict', 'withdrawal preview changed')
    let entries = tx
      .selectFrom('scope_extra_entries')
      .selectAll()
      .where('grant_id', '=', grant)
      .where('withdrawn_at', 'is', null)
      .limit(1001)
    if (body.delta.kind === 'withdraw') entries = entries.where('file_id', '=', body.delta.fileId)
    const rows = await entries.execute()
    if (rows.length > 1000) throw new AbeleError('too_large', 'asset list bound reached')
    let nextGeneration = generation
    for (const entry of rows) {
      if (body.delta.kind === 'remove-sponsor')
        await tx
          .deleteFrom('scope_extra_sponsors')
          .where('entry_id', '=', entry.id)
          .where('note_id', '=', body.delta.sponsorId)
          .execute()
      const remains = await tx
        .selectFrom('scope_extra_sponsors')
        .select('note_id')
        .where('entry_id', '=', entry.id)
        .limit(1)
        .executeTakeFirst()
      if (body.delta.kind === 'withdraw' || !remains) {
        nextGeneration++
        await tx
          .updateTable('scope_extra_entries')
          .set({ withdrawn_at: at.toISOString(), withdrawal_generation: nextGeneration })
          .where('id', '=', entry.id)
          .execute()
        await tx.deleteFrom('scope_extra_sponsors').where('entry_id', '=', entry.id).execute()
        await tx
          .updateTable('scope_trash')
          .set({ eligible: 0 })
          .where('grant_id', '=', grant)
          .where('file_id', '=', entry.file_id)
          .where(
            'interval_id',
            'in',
            tx
              .selectFrom('scope_admission_intervals')
              .select('id')
              .where('grant_id', '=', grant)
              .where('file_id', '=', entry.file_id)
              .where('intrinsic', '=', 0)
          )
          .execute()
        await reconcile(tx, deps, row, vault, entry.file_id, false)
      }
    }
    await tx
      .updateTable('scope_grants')
      .set({ publication_revision: sql<number>`publication_revision + 1` })
      .where('id', '=', grant)
      .execute()
    await outcome(
      tx,
      grant,
      device.deviceId,
      body.intentId,
      requestHash,
      row.publication_revision + 1,
      nextGeneration,
      at
    )
    return assetView(tx, deps, vault, grant)
  })
}
