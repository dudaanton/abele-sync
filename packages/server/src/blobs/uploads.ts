import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AbeleError, type UploadBeginResponse } from '@abele/sync-protocol'
import type { Kysely } from 'kysely'
import type { Config } from '../config.js'
import type { Dialect } from '../db/connect.js'
import { readJson, writeJson } from '../db/json.js'
import type { Database } from '../db/schema.js'
import { newId } from '../ids.js'
import { withVaultLock } from '../oplog/lock.js'
import { hasRoom, waitOn, type UploadOwner } from './pending.js'
import { SEAL_OVERHEAD, type BlobStore } from './store.js'

/**
 * Resumable uploads. A client that loses its connection halfway through a large
 * attachment comes back, sends the parts it still owes, and completes; nothing
 * it already sent is sent twice.
 *
 * Each part is a file under `<tmpDir>/<uploadId>/<index>`, and those files are
 * what an upload knows about itself: parts arrive in parallel, so completing
 * asks the directory which indexes are there at the size they should be rather
 * than trusting a column two concurrent writers could have raced over.
 * `parts_received` is kept as a hint for a client asking what it still owes.
 *
 * A part is sealed before it touches the volume, as a blob is (`BlobStore.sealPart`), under a
 * key bound to its upload and index: the volume without the master key reads nothing of an
 * upload in progress, and a part moved to another place does not open there. Completing opens
 * the parts in order, one at a time, and hands them to the store as a stream (`putChunks`),
 * which hashes them, checks the sha the client named, and encrypts them into place. Nothing
 * joined is ever written out in plaintext.
 *
 * An upload opened for a device (`owner`) belongs to it: only it may send parts or complete it,
 * it counts against the vault's quota at its declared size from the moment it opens (its parts
 * are on the volume long before a blob is), and it goes when the device is revoked. A device
 * opening the same bytes again replaces its earlier upload of them. Once completion begins, no
 * part may change: what is joined is what was there when it began.
 */
export class UploadManager {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly store: BlobStore,
    private readonly tmpDir: string,
    private readonly partBytes: number,
    private readonly maxFileBytes: number,
    private readonly now: () => Date = () => new Date(),
    private readonly dialect: Dialect = 'sqlite'
  ) {}

  /**
   * Open an upload of a known size, and say how it is to be cut into parts. With an owner the
   * upload is counted against its vault, under the vault's lock, and replaces any upload of the
   * same bytes that device has open and is not completing.
   */
  async begin(sha: string, size: number, owner?: UploadOwner): Promise<UploadBeginResponse> {
    if (!Number.isInteger(size) || size <= 0) {
      throw new AbeleError('invalid_request', 'an upload needs a positive whole size')
    }
    if (size > this.maxFileBytes) {
      throw new AbeleError('too_large', 'that file is larger than this server accepts', {
        size,
        max_bytes: this.maxFileBytes,
      })
    }

    const id = newId()
    const row = {
      id,
      sha,
      size,
      part_size: this.partBytes,
      parts_received: writeJson([]),
      created_at: this.now().toISOString(),
      vault_id: owner?.vaultId ?? null,
      device_id: owner?.deviceId ?? null,
      completing_at: null,
    }
    // The row first: a directory the sweep cannot see is a directory nobody ever removes.
    if (owner === undefined) {
      await this.db.insertInto('uploads').values(row).execute()
    } else {
      const result = await withVaultLock(this.db, this.dialect, owner.vaultId, async (trx) => {
        const earlier = await trx
          .selectFrom('uploads')
          .select(['id', 'size', 'part_size'])
          .where('vault_id', '=', owner.vaultId)
          .where('device_id', '=', owner.deviceId)
          .where('sha', '=', sha)
          .where('completing_at', 'is', null)
          .execute()
        // Re-open the same upload after a client restart rather than discarding the bytes it
        // already sent. An upload of another size is replaced under the same vault lock.
        const same = earlier.find((upload) => Number(upload.size) === size)
        if (same !== undefined) return { same, replaced: [] as string[] }
        const ids = earlier.map((upload) => upload.id)
        if (ids.length > 0) await trx.deleteFrom('uploads').where('id', 'in', ids).execute()
        await hasRoom(trx, owner.vaultId, sha, size)
        await trx.insertInto('uploads').values(row).execute()
        return { same: null, replaced: ids }
      })
      if (result.same !== null) {
        const existing = result.same
        const parts = partCount(size, existing.part_size)
        const missing = new Set(
          await this.missingParts(this.dirFor(existing.id), size, existing.part_size, parts)
        )
        return {
          upload_id: existing.id,
          part_size: existing.part_size,
          parts,
          received: [...Array(parts).keys()].filter((index) => !missing.has(index)),
        }
      }
      for (const earlier of result.replaced) {
        await rm(this.dirFor(earlier), { recursive: true, force: true })
      }
    }
    await mkdir(this.dirFor(id), { recursive: true })
    return {
      upload_id: id,
      part_size: this.partBytes,
      parts: partCount(size, this.partBytes),
      received: [],
    }
  }

  /**
   * Take one part. Every part but the last is exactly the part size, and the
   * last is exactly the remainder: a part of any other length is a client that
   * has lost count, and taking it would only fail the hash later.
   */
  async putPart(
    uploadId: string,
    index: number,
    bytes: Uint8Array,
    owner?: UploadOwner
  ): Promise<void> {
    const upload = await this.row(uploadId, owner)
    if (upload.completing_at !== null) {
      throw new AbeleError('conflict', 'this upload is being completed; its parts cannot change')
    }
    const parts = partCount(upload.size, upload.part_size)
    if (!Number.isInteger(index) || index < 0 || index >= parts) {
      throw new AbeleError('invalid_request', `this upload has no part ${index}`, { parts })
    }

    const expected = expectedPartBytes(index, upload.size, upload.part_size)
    if (bytes.length !== expected) {
      throw new AbeleError('invalid_request', `part ${index} is not the size this upload expects`, {
        expected_bytes: expected,
        actual_bytes: bytes.length,
      })
    }

    await mkdir(this.dirFor(uploadId), { recursive: true })
    await writeFile(
      join(this.dirFor(uploadId), String(index)),
      this.store.sealPart(bytes, partLabel(uploadId, index))
    )

    // A hint, not the record: two parts in flight at once can each write what the
    // other has not seen. The file on disk is what `complete` counts.
    const received = new Set(readJson<number[]>(upload.parts_received))
    received.add(index)
    await this.db
      .updateTable('uploads')
      .set({ parts_received: writeJson([...received].sort((a, b) => a - b)) })
      .where('id', '=', uploadId)
      .execute()
  }

  /**
   * Join the parts and store the result. The upload is gone afterwards, row and directory both,
   * and the bytes wait for a commit as a simple upload's do (`blob_uploads`), counted in place
   * of the upload that brought them.
   *
   * Completion is claimed first, so no part changes while the parts are joined; a completion
   * that fails lets the claim go, and the client may send parts again.
   */
  async complete(uploadId: string, owner?: UploadOwner): Promise<{ sha: string; size: number }> {
    const upload = await this.row(uploadId, owner)
    const claimed = await this.db
      .updateTable('uploads')
      .set({ completing_at: this.now().toISOString() })
      .where('id', '=', uploadId)
      .where('completing_at', 'is', null)
      .executeTakeFirst()
    if (Number(claimed.numUpdatedRows ?? 0n) === 0) {
      throw new AbeleError('conflict', 'this upload is already being completed')
    }
    let stored: { sha: string; size: number }
    try {
      stored = await this.join(uploadId, upload.sha, Number(upload.size), upload.part_size)
    } catch (error) {
      await this.db
        .updateTable('uploads')
        .set({ completing_at: null })
        .where('id', '=', uploadId)
        .execute()
      throw error
    }

    const vaultId = upload.vault_id ?? owner?.vaultId
    const deviceId = upload.device_id ?? owner?.deviceId
    if (vaultId === undefined || deviceId === undefined) {
      await this.db.deleteFrom('uploads').where('id', '=', uploadId).execute()
    } else {
      await withVaultLock(this.db, this.dialect, vaultId, async (trx) => {
        await waitOn(trx, { vaultId, deviceId, sha: stored.sha, size: stored.size, at: this.now() })
        await trx.deleteFrom('uploads').where('id', '=', uploadId).execute()
      })
    }
    await rm(this.dirFor(uploadId), { recursive: true, force: true })
    return stored
  }

  /**
   * A process can die after claiming completion. On the next start, finish a blob already
   * sealed by that completion, or release the claim so the original device can send missing
   * parts again. Do this before listening, when no completion from this process can race it.
   */
  async recoverCompletions(): Promise<void> {
    const claimed = await this.db
      .selectFrom('uploads')
      .select(['id', 'sha', 'size', 'part_size', 'vault_id', 'device_id'])
      .where('completing_at', 'is not', null)
      .execute()
    for (const upload of claimed) {
      // The claim precedes hashing the parts. A shared blob from another vault
      // cannot stand in for proof that this upload supplied its own bytes.
      try {
        await this.join(upload.id, upload.sha, Number(upload.size), upload.part_size)
      } catch (error) {
        if (
          !(error instanceof AbeleError) ||
          (error.code !== 'invalid_request' && error.code !== 'hash_mismatch')
        )
          throw error
        await this.db
          .updateTable('uploads')
          .set({ completing_at: null })
          .where('id', '=', upload.id)
          .execute()
        continue
      }
      if (upload.vault_id !== null && upload.device_id !== null) {
        await withVaultLock(this.db, this.dialect, upload.vault_id, async (trx) => {
          await waitOn(trx, {
            vaultId: upload.vault_id!,
            deviceId: upload.device_id!,
            sha: upload.sha,
            size: Number(upload.size),
            at: this.now(),
          })
          await trx.deleteFrom('uploads').where('id', '=', upload.id).execute()
        })
      } else {
        await this.db.deleteFrom('uploads').where('id', '=', upload.id).execute()
      }
      await rm(this.dirFor(upload.id), { recursive: true, force: true })
    }
  }

  /** The parts opened in order and handed to the store, which hashes them as it seals them. */
  private async join(
    uploadId: string,
    sha: string,
    size: number,
    partSize: number
  ): Promise<{ sha: string; size: number }> {
    const parts = partCount(size, partSize)
    const dir = this.dirFor(uploadId)
    const missing = await this.missingParts(dir, size, partSize, parts)
    if (missing.length > 0) {
      throw new AbeleError('invalid_request', 'the upload is still missing parts', { missing })
    }

    const opened = async function* (store: BlobStore): AsyncIterable<Uint8Array> {
      for (let index = 0; index < parts; index++) {
        const bytes = store.openPart(
          await readFile(join(dir, String(index))),
          partLabel(uploadId, index)
        )
        if (bytes === null) {
          // Changed on the volume since it was sealed, or sealed for another place: it is
          // gone, and the client is told to send it again.
          await rm(join(dir, String(index)), { force: true })
          throw new AbeleError('invalid_request', 'the upload is still missing parts', {
            missing: [index],
          })
        }
        yield bytes
      }
    }
    // The store hashes what it is given as it seals it: a wrong sha throws before anything is filed.
    const stored = await this.store.putChunks(sha, () => opened(this.store))
    return { sha: stored.sha, size: stored.size }
  }

  /** Every upload a device has open, with its parts: for a device that has been revoked. */
  async dropOwnedBy(deviceId: string): Promise<number> {
    const owned = await this.db
      .selectFrom('uploads')
      .select('id')
      .where('device_id', '=', deviceId)
      .execute()
    if (owned.length === 0) return 0
    const ids = owned.map((upload) => upload.id)
    await this.db.deleteFrom('uploads').where('id', 'in', ids).execute()
    for (const id of ids) await rm(this.dirFor(id), { recursive: true, force: true })
    return ids.length
  }

  /** What an upload is of: the sha it was opened under and its size. */
  async describe(uploadId: string): Promise<{ sha: string; size: number }> {
    const { sha, size } = await this.row(uploadId)
    return { sha, size: Number(size) }
  }

  /** Drop uploads begun before `olderThan`, with their parts. Answers how many went. */
  async sweep(olderThan: Date): Promise<number> {
    const stale = await this.db
      .selectFrom('uploads')
      .select('id')
      .where('created_at', '<', olderThan.toISOString())
      .execute()
    await this.sweepStrays()
    if (stale.length === 0) return 0

    for (const { id } of stale) await rm(this.dirFor(id), { recursive: true, force: true })
    await this.db
      .deleteFrom('uploads')
      .where(
        'id',
        'in',
        stale.map((row) => row.id)
      )
      .execute()
    return stale.length
  }

  /**
   * Part folders no upload names: a part that landed as its upload was being swept, or a
   * folder whose removal failed. Nothing can finish them, so they go.
   */
  private async sweepStrays(): Promise<void> {
    const names = await readdir(this.tmpDir).catch(() => [] as string[])
    if (names.length === 0) return
    const known = new Set(
      (await this.db.selectFrom('uploads').select('id').execute()).map((row) => row.id)
    )
    for (const name of names) {
      if (!known.has(name)) await rm(join(this.tmpDir, name), { recursive: true, force: true })
    }
  }

  private dirFor(uploadId: string): string {
    return join(this.tmpDir, uploadId)
  }

  /**
   * Which part indexes are not on disk at the size they should be. This, and
   * not the row, is what an upload has: parts are written in parallel, and a
   * part half-written or removed under us must count as missing rather than
   * fail the join with a disk error the client cannot read.
   */
  private async missingParts(
    dir: string,
    size: number,
    partSize: number,
    parts: number
  ): Promise<number[]> {
    const present = await Promise.all(
      [...Array(parts).keys()].map(async (index) => {
        const info = await stat(join(dir, String(index))).catch((error: NodeJS.ErrnoException) => {
          // A part that is not there is missing; a disk that will not answer is not the same thing.
          if (error.code === 'ENOENT') return null
          throw error
        })
        return (
          info !== null &&
          info.isFile() &&
          info.size === expectedPartBytes(index, size, partSize) + SEAL_OVERHEAD
        )
      })
    )
    return [...Array(parts).keys()].filter((index) => present[index] !== true)
  }

  /** The upload, if there is one this owner may touch: another device's is not found either. */
  private async row(uploadId: string, owner?: UploadOwner) {
    const upload = await this.db
      .selectFrom('uploads')
      .selectAll()
      .where('id', '=', uploadId)
      .executeTakeFirst()
    if (
      !upload ||
      (owner !== undefined && upload.device_id !== null && upload.device_id !== owner.deviceId)
    ) {
      throw new AbeleError('not_found', `no upload ${uploadId}`)
    }
    return upload
  }
}

/** Build an upload manager outside the app: retention sweeps expired uploads without an HTTP request. */
export function createUploadManager(deps: {
  config: Config
  db: Kysely<Database>
  store: BlobStore
  now?: () => Date
  dialect?: Dialect
}): UploadManager {
  return new UploadManager(
    deps.db,
    deps.store,
    join(deps.config.blobDir, 'uploads'),
    deps.config.partBytes,
    deps.config.maxFileBytes,
    deps.now,
    deps.dialect
  )
}

/** How many parts a file of that size is cut into. The last one is short unless it divides evenly. */
const partCount = (size: number, partBytes: number): number => Math.ceil(size / partBytes)

/** How long part `index` must be: the part size, or the remainder for the last one. */
const expectedPartBytes = (index: number, size: number, partBytes: number): number =>
  index === partCount(size, partBytes) - 1 ? size - index * partBytes : partBytes

/** What a part is sealed under: its upload and its place in it. */
const partLabel = (uploadId: string, index: number): string => `${uploadId}/${index}`
