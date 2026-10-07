import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { AbeleError } from '@abele/sync-protocol'
import { sql, type Kysely, type Transaction } from 'kysely'
import type { Dialect } from '../db/connect.js'
import type { Database } from '../db/schema.js'
import { withVaultLock } from '../oplog/lock.js'
import { getVaultSettings } from '../vault/vaults.js'
import { TOMBSTONE } from './refs.js'
import type { BlobStore } from './store.js'
import type { UploadManager } from './uploads.js'

/**
 * Uploads no version names yet (`blob_uploads`). A `PUT /blobs/:sha` stores the bytes at once,
 * but only a version makes a `blobs` row, so until the commit arrives the bytes are counted
 * here: against the vault's quota while they wait, and by retention once they have waited too
 * long. A commit that names the sha takes its rows away (`forgetUpload`); from then on the
 * `blobs` row and its reference count are what keep the bytes.
 *
 * Nothing here deletes a blob a row still stands for. The bytes of a sha go only once the sha
 * is claimed the way retention claims one — a `blobs` row inserted as a tombstone, which fails
 * if any row is there already and which `addRef` refuses — so a commit racing the removal
 * either wins the row first and keeps the bytes, or meets the tombstone and is told to upload
 * again. No ordering leaves a version pointing at bytes that went.
 */

/** Who an upload is for: the vault it counts against and the device waiting to commit it. */
export interface UploadOwner {
  vaultId: string
  deviceId: string
}

/** What admitting an upload needs: the database, and its dialect for the vault's lock. */
export interface AdmitDeps {
  db: Kysely<Database>
  dialect: Dialect
}

/**
 * Let an upload in, and count it. Called once its bytes are known to hash to its sha, so the
 * size counted is the sha's own; and before they are stored, so there is no moment at which the
 * store holds bytes nothing accounts for. Answers whether the row is new, which is what
 * `withdrawUpload` needs to know if storing the bytes then fails.
 *
 * The check and the row are one step under the vault's lock (`hasRoom`), so two uploads at once
 * cannot both find the room only one of them fits in. Each device waiting on a sha has a row of
 * its own, so revoking one of them leaves the bytes to the others.
 */
export async function admitUpload(
  deps: AdmitDeps,
  upload: UploadOwner & { sha: string; size: number; at: Date }
): Promise<boolean> {
  return withVaultLock(deps.db, deps.dialect, upload.vaultId, async (trx) => {
    await hasRoom(trx, upload.vaultId, upload.sha, upload.size, upload.at)
    const existing = await trx
      .selectFrom('blob_uploads')
      .select('sha')
      .where('vault_id', '=', upload.vaultId)
      .where('sha', '=', upload.sha)
      .where('device_id', '=', upload.deviceId)
      .executeTakeFirst()
    await waitOn(trx, upload)
    return existing === undefined
  })
}

/** An admission whose bytes never made it into the store: the row it made goes again. */
export async function withdrawUpload(
  db: Kysely<Database>,
  upload: UploadOwner & { sha: string }
): Promise<void> {
  await db
    .deleteFrom('blob_uploads')
    .where('vault_id', '=', upload.vaultId)
    .where('sha', '=', upload.sha)
    .where('device_id', '=', upload.deviceId)
    .execute()
}

/**
 * Whether the vault has room for `size` more bytes of uploads nobody has committed, inside the
 * transaction that will then count them; throws when it has not.
 *
 * Counted: every sha some device of the vault waits on, once, whoever sent it — `sha` itself
 * left out, as a second upload of it adds nothing — and every upload in progress at the size it
 * declared, since its parts sit on the volume long before a blob does.
 *
 * That never refuses a batch the commit would take whole: every byte a batch uploads is live
 * once it lands, and the commit holds live bytes to the quota. More than the whole quota on its
 * own can never fit, and is refused as the commit would refuse it (`quota_exceeded`, which a
 * client remembers as final for that sha). Anything else only has to wait for other uploads to
 * be committed or given up on (`quota_waiting`, which a client asks again about later). So a
 * token can leave at most one quota's worth of bytes on the volume without committing, and what
 * it leaves is swept after a day. A vault without a quota has no cap here.
 */
export async function hasRoom(
  trx: Transaction<Database>,
  vaultId: string,
  sha: string,
  size: number,
  at: Date = new Date(),
  replacingScopedReservation?: string,
  discountProvedSha = true
): Promise<void> {
  const { quota_bytes } = await getVaultSettings({ db: trx }, vaultId)
  if (quota_bytes === null) return
  if (size > quota_bytes) {
    throw new AbeleError('quota_exceeded', 'the file is larger than the whole of the vault quota', {
      size,
      quota_bytes,
    })
  }
  // Hash-only reservations cannot discount private matching entitlements.
  const waiting = await waitingBytes(
    trx,
    vaultId,
    discountProvedSha ? sha : undefined,
    at,
    replacingScopedReservation
  )
  if (waiting + size > quota_bytes) {
    throw new AbeleError(
      'quota_waiting',
      'the uncommitted uploads of this vault leave no room for this one yet',
      { waiting_bytes: waiting, size, quota_bytes }
    )
  }
}

/** The row that says this device waits on these bytes, made or brought up to date. */
export async function waitOn(
  trx: Transaction<Database>,
  upload: UploadOwner & { sha: string; size: number; at: Date }
): Promise<void> {
  await trx
    .insertInto('blob_uploads')
    .values({
      vault_id: upload.vaultId,
      sha: upload.sha,
      device_id: upload.deviceId,
      size: upload.size,
      created_at: upload.at.toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['vault_id', 'sha', 'device_id']).doUpdateSet({
        size: upload.size,
        created_at: upload.at.toISOString(),
      })
    )
    .execute()
}

/** The bytes a vault's uploads are waiting to be committed with, one sha left out; see `hasRoom`. */
async function waitingBytes(
  trx: Transaction<Database>,
  vaultId: string,
  except: string | undefined,
  at: Date,
  replacingScopedReservation?: string
): Promise<number> {
  const entitlements = trx
    .selectFrom('blob_uploads')
    .select(['sha', 'size'])
    .where('vault_id', '=', vaultId)
    .unionAll(
      trx
        .selectFrom('scope_blob_uploads')
        .select(['sha', 'size'])
        .where('vault_id', '=', vaultId)
        .where((eb) =>
          eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())])
        )
    )
    .as('entitlements')
  let bySha = trx
    .selectFrom(entitlements)
    .select((eb) => ['sha', eb.fn.max<number>('size').as('size')])
    .groupBy('sha')
  if (except !== undefined) bySha = bySha.where('sha', '!=', except)
  const perSha = bySha.as('per_sha')
  const waiting = await trx
    .selectFrom(perSha)
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('per_sha.size'), sql<number>`0`).as('total'))
    .executeTakeFirst()
  const inProgress = await trx
    .selectFrom('uploads')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('size'), sql<number>`0`).as('total'))
    .where('vault_id', '=', vaultId)
    .executeTakeFirst()
  // Postgres sums into a bigint, which its driver hands over as a string.
  let scopedQuery = trx
    .selectFrom('scope_uploads')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('size'), sql<number>`0`).as('total'))
    .where('vault_id', '=', vaultId)
    .where('expires_at', '>', at.toISOString())
  if (replacingScopedReservation !== undefined)
    scopedQuery = scopedQuery.where('id', '!=', replacingScopedReservation)
  const scopedProgress = await scopedQuery.executeTakeFirst()
  return (
    Number(waiting?.total ?? 0) +
    Number(inProgress?.total ?? 0) +
    Number(scopedProgress?.total ?? 0)
  )
}

/** A version of the vault names the sha now: it is the `blobs` row's to keep, not these rows'. */
export async function forgetUpload(
  trx: Transaction<Database>,
  vaultId: string,
  sha: string
): Promise<void> {
  await trx
    .deleteFrom('blob_uploads')
    .where('vault_id', '=', vaultId)
    .where('sha', '=', sha)
    .execute()
}

export interface CollectDeps {
  db: Kysely<Database>
  store: BlobStore
  now?: () => Date
}

/**
 * Retention's half: uploads older than `cutoff` are given up on, and then every blob in the
 * store that neither a `blobs` row nor a waiting upload stands for is removed. The store is
 * walked rather than the rows, so bytes that never had a row at all go too — an upload from
 * before this table, or a merge whose commit rolled back after its result was stored.
 */
export async function collectUnreferenced(deps: CollectDeps, cutoff: Date): Promise<number> {
  await deps.db.deleteFrom('blob_uploads').where('created_at', '<', cutoff.toISOString()).execute()
  let removed = 0
  for await (const sha of storedShas(deps.store)) {
    if (await removeIfUnclaimed(deps, sha, cutoff)) removed += 1
  }
  return removed
}

/**
 * A revoked device's waiting uploads, its uploads in progress with their parts, and the bytes of
 * any that no other device waits on and no version names. Answers how many blobs went.
 */
export async function dropUploadsOf(
  deps: CollectDeps & { now: () => Date; uploads?: Pick<UploadManager, 'dropOwnedBy'> },
  deviceId: string
): Promise<number> {
  await deps.uploads?.dropOwnedBy(deviceId)
  const rows = await deps.db
    .selectFrom('blob_uploads')
    .select('sha')
    .where('device_id', '=', deviceId)
    .execute()
  if (rows.length === 0) return 0
  await deps.db.deleteFrom('blob_uploads').where('device_id', '=', deviceId).execute()
  let removed = 0
  for (const { sha } of rows) {
    if (await removeIfUnclaimed(deps, sha, deps.now())) removed += 1
  }
  return removed
}

/**
 * Remove a sha's bytes if no row stands for them: claim it with a tombstone row, make sure no
 * upload has arrived for it since, remove the bytes, drop the tombstone. Any row already there
 * — referenced, released, or tombstoned by the other sweep — makes the claim fail, and the sha
 * is left to whoever owns that row.
 */
async function removeIfUnclaimed(deps: CollectDeps, sha: string, at: Date): Promise<boolean> {
  return deps.db.transaction().execute((trx) => removeUnclaimed({ ...deps, db: trx }, sha, at))
}

/** The claim stays locked until its bytes and row are gone, including during recovery. */
async function removeUnclaimed(deps: CollectDeps, sha: string, at: Date): Promise<boolean> {
  if (await hasWaitingEntitlement(deps.db, sha, deps.now?.() ?? new Date())) return false
  const now = at.toISOString()
  const claimed = await deps.db
    .insertInto('blobs')
    .values({
      sha,
      size: 0,
      storage_ref: deps.store.pathFor(sha),
      refs: TOMBSTONE,
      created_at: now,
      last_referenced_at: now,
    })
    .onConflict((oc) => oc.column('sha').doNothing())
    .executeTakeFirst()
  if (Number(claimed.numInsertedOrUpdatedRows ?? 0n) === 0) return false

  const release = () =>
    deps.db.deleteFrom('blobs').where('sha', '=', sha).where('refs', '=', TOMBSTONE).execute()
  // An upload that came in between the look and the claim is somebody's commit in the making.
  if (await hasWaitingEntitlement(deps.db, sha, deps.now?.() ?? new Date())) {
    await release()
    return false
  }
  try {
    await deps.store.delete(sha)
  } catch (error) {
    console.error(`retention could not remove the bytes of unreferenced blob ${sha}:`, error)
    await release()
    return false
  }
  await release()
  return true
}

export async function hasWaitingEntitlement(
  db: Kysely<Database>,
  sha: string,
  at: Date
): Promise<boolean> {
  const row = await db
    .selectFrom('blob_uploads')
    .select('sha')
    .where('sha', '=', sha)
    .limit(1)
    .executeTakeFirst()
  if (row !== undefined) return true
  const scoped = await db
    .selectFrom('scope_blob_uploads')
    .select('sha')
    .where('sha', '=', sha)
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', at.toISOString())]))
    .limit(1)
    .executeTakeFirst()
  return scoped !== undefined
}

const HEX2 = /^[0-9a-f]{2}$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/** Every sha the store holds bytes for, from its `aa/bb/<sha>` fan-out; nothing else in it. */
async function* storedShas(store: BlobStore): AsyncIterable<string> {
  for await (const first of folders(store.dir)) {
    for await (const second of folders(join(store.dir, first))) {
      const dir = await opendir(join(store.dir, first, second)).catch(() => null)
      if (dir === null) continue
      for await (const entry of dir) {
        if (
          entry.isFile() &&
          SHA256_HEX.test(entry.name) &&
          entry.name.startsWith(first + second)
        ) {
          yield entry.name
        }
      }
    }
  }
}

/** The two-hex-digit folders directly under `path`. */
async function* folders(path: string): AsyncIterable<string> {
  const dir = await opendir(path).catch(() => null)
  if (dir === null) return
  for await (const entry of dir) {
    if (entry.isDirectory() && HEX2.test(entry.name)) yield entry.name
  }
}
