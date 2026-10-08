import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { AbeleError } from '@abele/sync-protocol'

/**
 * Content-addressed blob storage. A blob is named by the sha-256 of its
 * plaintext and stored encrypted: the same bytes always land in the same place,
 * and nothing readable ever reaches the disk.
 *
 * On disk each blob is one envelope:
 *
 *     'ABS1' | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag
 *
 * The key is derived per blob, so one blob's key opens only that blob, and the
 * sha it is derived from binds the ciphertext to the name it is filed under.
 * A wrong master key does not decrypt to rubbish: the tag check fails.
 */
export class BlobStore {
  constructor(
    readonly dir: string,
    private readonly masterKey: Buffer
  ) {}

  /** `dir/aa/bb/<sha>`: two levels of fan-out, so no directory holds millions of entries. */
  pathFor(sha: string): string {
    return join(this.dir, sha.slice(0, 2), sha.slice(2, 4), sha)
  }

  /** Store bytes already in memory. A blob that is there already is left exactly as it is. */
  async put(bytes: Uint8Array, expectedSha?: string): Promise<PutResult> {
    const sha = shaOf(bytes)
    if (expectedSha !== undefined && expectedSha !== sha) {
      throw new AbeleError(
        'hash_mismatch',
        'the bytes do not hash to the sha they were sent under',
        {
          expected: expectedSha,
          actual: sha,
        }
      )
    }
    if (await this.intact(sha)) return { sha, size: bytes.length, created: false }

    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.keyFor(sha), nonce)
    const body = Buffer.concat([cipher.update(bytes), cipher.final()])
    await this.commit(sha, async (tmp) => {
      const handle = await open(tmp, 'wx')
      try {
        await handle.writeFile(Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()]))
        await handle.datasync()
      } finally {
        await handle.close()
      }
    })
    return { sha, size: bytes.length, created: true }
  }

  /** Store a file, as `putChunks` stores what it reads: never the whole of it in memory. */
  async putFile(tmpPath: string, expectedSha: string): Promise<PutResult> {
    return this.putChunks(expectedSha, () => createReadStream(tmpPath))
  }

  /**
   * Store bytes that arrive in pieces, in one pass over `source` and never in one piece: each
   * piece is hashed and encrypted as it comes, into a temporary file that is renamed into place
   * only once the whole of it hashed to `expectedSha`. What is filed is therefore exactly what
   * was hashed — a source that would read differently a second time is only ever read once —
   * and an upload of two hundred megabytes costs a piece at a time, with no plaintext copy of
   * it written anywhere.
   *
   * A blob already there is kept when it opens to these bytes; the pieces are then only hashed,
   * so a wrong sha is still refused. One that does not (`intact`) is replaced.
   */
  async putChunks(
    expectedSha: string,
    source: () => AsyncIterable<Uint8Array>
  ): Promise<PutResult> {
    if (await this.intact(expectedSha)) {
      const { sha, size } = await hashChunks(source())
      if (sha !== expectedSha) throw mismatch(expectedSha, sha)
      return { sha, size, created: false }
    }

    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.keyFor(expectedSha), nonce)
    const hash = createHash('sha256')
    let size = 0
    await this.commit(expectedSha, async (tmp) => {
      const out = createWriteStream(tmp, { flags: 'wx' })
      const guarded = guardWrites(out)
      try {
        await guarded.write(Buffer.concat([MAGIC, nonce]))
        for await (const chunk of source()) {
          hash.update(chunk)
          size += chunk.length
          const sealed = cipher.update(chunk)
          if (sealed.length > 0) await guarded.write(sealed)
        }
        const tail = cipher.final()
        if (tail.length > 0) await guarded.write(tail)
        await guarded.write(cipher.getAuthTag())
        await guarded.end()
      } finally {
        out.destroy()
      }
      // Thrown before the rename: the temporary file goes, and nothing is filed.
      const sha = hash.digest('hex')
      if (sha !== expectedSha) throw mismatch(expectedSha, sha)
      await syncFile(tmp)
    })
    return { sha: expectedSha, size, created: true }
  }

  /**
   * Whether the blob is on disk and opens to bytes that hash to its name. Read in pieces, so a
   * large blob costs a piece at a time. A blob that is not there, will not open, or opens to
   * other bytes answers false — the caller then files the bytes it has over it. A disk that will
   * not answer is not the same thing, and throws.
   */
  async intact(sha: string): Promise<boolean> {
    return (await this.verify(sha)) !== null
  }

  /** Authenticated SHA and actual decrypted length in one bounded-memory read.
   * Null means absent/corrupt; I/O failures still throw. Never trusts SQL or envelope length
   * as the plaintext count. The open descriptor binds header, body and tag to one file.
   */
  async verify(sha: string): Promise<{ sha: string; size: number } | null> {
    let handle: FileHandle
    try {
      handle = await open(this.pathFor(sha), 'r')
    } catch (error) {
      if (codeOf(error) === 'ENOENT') return null
      throw error
    }
    try {
      const { size } = await handle.stat()
      if (size < HEADER_BYTES + TAG_BYTES) return null
      const header = Buffer.alloc(HEADER_BYTES)
      const tag = Buffer.alloc(TAG_BYTES)
      await handle.read(header, 0, HEADER_BYTES, 0)
      await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES)
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) return null
      const decipher = createDecipheriv(ALGORITHM, this.keyFor(sha), header.subarray(MAGIC.length))
      decipher.setAuthTag(tag)
      const hash = createHash('sha256')
      let actualSize = 0
      // Do not create a stream for an empty ciphertext: a reversed range can close the
      // FileHandle under us even with autoClose false, before the tag is checked.
      if (size > HEADER_BYTES + TAG_BYTES) {
        const body = handle.createReadStream({
          start: HEADER_BYTES,
          end: size - TAG_BYTES - 1,
          autoClose: false,
        })
        for await (const chunk of body) {
          const bytes = decipher.update(chunk as Buffer)
          hash.update(bytes)
          actualSize += bytes.length
        }
      }
      try {
        const tail = decipher.final()
        hash.update(tail)
        actualSize += tail.length
      } catch {
        return null
      }
      return hash.digest('hex') === sha ? { sha, size: actualSize } : null
    } finally {
      await handle.close()
    }
  }

  /**
   * Seal one part of an upload for the volume: the blob envelope, under a key derived from the
   * master key and the part's own place (`label`, the upload and the index), so a part opens
   * only where it was written and a copy of the volume without the key reads nothing.
   */
  sealPart(bytes: Uint8Array, label: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.partKeyFor(label), nonce)
    const body = Buffer.concat([cipher.update(bytes), cipher.final()])
    return Buffer.concat([MAGIC, nonce, body, cipher.getAuthTag()])
  }

  /** A sealed part's bytes, or `null` when the envelope does not open under that label. */
  openPart(envelope: Buffer, label: string): Buffer | null {
    if (
      envelope.length < HEADER_BYTES + TAG_BYTES ||
      !envelope.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      return null
    }
    const nonce = envelope.subarray(MAGIC.length, HEADER_BYTES)
    const decipher = createDecipheriv(ALGORITHM, this.partKeyFor(label), nonce)
    decipher.setAuthTag(envelope.subarray(envelope.length - TAG_BYTES))
    try {
      return Buffer.concat([
        decipher.update(envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES)),
        decipher.final(),
      ])
    } catch {
      return null
    }
  }

  /**
   * Is that blob on disk? The only question the upload and commit paths ask
   * before they trust it, so it answers `false` for a blob that is not there
   * and nothing at all for a disk that would not say: a store that cannot be
   * read must not look empty.
   */
  async has(sha: string): Promise<boolean> {
    return stat(this.pathFor(sha)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      }
    )
  }

  /** The size of the authenticated upload's plaintext, without allocating its body. */
  async size(sha: string): Promise<number> {
    const size = (await stat(this.pathFor(sha))).size - SEAL_OVERHEAD
    if (size < 0) throw new AbeleError('internal', `blob ${sha} has a truncated envelope`)
    return size
  }

  /** The whole blob, decrypted. Blobs are capped at 200 MB, so one buffer is honest here. */
  async get(sha: string): Promise<Buffer> {
    let envelope: Buffer
    try {
      envelope = await readFile(this.pathFor(sha))
    } catch (error) {
      // Only a blob that is not there is `not_found`; a disk that is unhappy must say so.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new AbeleError('not_found', `no blob ${sha}`)
    }
    return this.open(sha, envelope)
  }

  /** The decrypted bytes from `start` to `end`, both ends included, clamped to what is there. */
  async getRange(sha: string, start: number, end: number): Promise<Buffer> {
    const bytes = await this.get(sha)
    const from = Math.max(0, Math.min(start, bytes.length))
    const to = Math.max(from, Math.min(end + 1, bytes.length))
    return bytes.subarray(from, to)
  }

  /** Remove a blob. Only retention calls this; a reference count reaching zero does not. */
  async delete(sha: string): Promise<void> {
    await rm(this.pathFor(sha), { force: true })
  }

  /**
   * Write through a temporary name in the same directory, then rename: a reader
   * sees all or nothing. `write` syncs the bytes it wrote before it returns, so
   * only a file that reached the disk whole is ever renamed; the rename is then
   * synced through the directory, so the blob a commit was told about is still
   * there after a crash that follows the answer.
   */
  private async commit(sha: string, write: (tmp: string) => Promise<void>): Promise<void> {
    const dest = this.pathFor(sha)
    const dir = dirname(dest)
    await mkdir(dir, { recursive: true })
    const tmp = `${dest}.tmp-${randomBytes(8).toString('hex')}`
    try {
      await write(tmp)
      await rename(tmp, dest)
    } catch (error) {
      // The write is what went wrong; a temp file that will not go must not say otherwise.
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
    await syncDir(dir)
  }

  private open(sha: string, envelope: Buffer): Buffer {
    if (
      envelope.length < HEADER_BYTES + TAG_BYTES ||
      !envelope.subarray(0, MAGIC.length).equals(MAGIC)
    ) {
      throw new AbeleError('internal', `blob ${sha} is not an envelope this server wrote`)
    }
    const nonce = envelope.subarray(MAGIC.length, HEADER_BYTES)
    const body = envelope.subarray(HEADER_BYTES, envelope.length - TAG_BYTES)
    const decipher = createDecipheriv(ALGORITHM, this.keyFor(sha), nonce)
    decipher.setAuthTag(envelope.subarray(envelope.length - TAG_BYTES))
    try {
      return Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
      // A failed tag means the wrong master key, or bytes that changed under us.
      throw new AbeleError('internal', `blob ${sha} could not be decrypted`)
    }
  }

  /** One key per blob, derived from the master key and the blob's own name. */
  private keyFor(sha: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.masterKey, HKDF_SALT, sha, KEY_BYTES))
  }

  /** One key per upload part, under a salt of its own so no part key is ever a blob key. */
  private partKeyFor(label: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.masterKey, PART_HKDF_SALT, label, KEY_BYTES))
  }
}

/** What storing a blob says: its name, its plaintext size, and whether this call is what created it. */
export interface PutResult {
  sha: string
  size: number
  created: boolean
}

/** The envelope's first four bytes: the format, so a stray file is never mistaken for a blob. */
const MAGIC = Buffer.from('ABS1')
const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const HEADER_BYTES = MAGIC.length + NONCE_BYTES
/** The HKDF salt is a constant: what varies per blob is the info, which is the sha. */
const HKDF_SALT = 'abele-blob'
/** The salt upload parts are sealed under; the info is the part's upload and index. */
const PART_HKDF_SALT = 'abele-upload-part'

/** How much longer a sealed part is than its bytes: the magic, the nonce and the tag. */
export const SEAL_OVERHEAD = HEADER_BYTES + TAG_BYTES

const shaOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const mismatch = (expected: string, actual: string): AbeleError =>
  new AbeleError('hash_mismatch', 'the bytes do not hash to the sha they were sent under', {
    expected,
    actual,
  })

/** Push a file's bytes to the disk before anything is renamed over them. */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.datasync()
  } finally {
    await handle.close()
  }
}

/**
 * Make a rename in `dir` durable: the new entry lives in the directory's own
 * blocks, which are synced through a handle on the directory. Not every platform
 * lets a directory be opened or synced — Windows refuses, and so do some
 * filesystems — and there the rename is as durable as the platform makes it,
 * which is the most that can be had: the file's own bytes were synced already.
 */
async function syncDir(dir: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(dir, 'r')
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(codeOf(error))) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED.has(codeOf(error))) return
    throw error
  } finally {
    await handle.close()
  }
}

/** What opening or syncing a directory answers where it is not a thing that can be done. */
const DIRECTORY_SYNC_UNSUPPORTED = new Set([
  'EISDIR',
  'EPERM',
  'EACCES',
  'EINVAL',
  'EBADF',
  'ENOTSUP',
])

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? ''

/** Read the pieces once, for their hash and their length; nothing of them is kept. */
async function hashChunks(
  chunks: AsyncIterable<Uint8Array>
): Promise<{ sha: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of chunks) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha: hash.digest('hex'), size }
}

/** Writing to a stream, in a way that cannot take the process down with it. */
export interface GuardedWrites {
  /** Write one chunk, waiting for it to flush: the callback is this loop's backpressure. */
  write(chunk: Buffer): Promise<void>
  /** Wait for something else that writes to the same stream, a `pipeline` for instance. */
  watch<T>(work: Promise<T>): Promise<T>
  /** Finish the file: everything written has been flushed and the handle is closed. */
  end(): Promise<void>
}

/**
 * Watch a write stream for as long as anything is being written to it. A stream
 * that fails — a full disk, a directory where a file was meant to be — announces
 * it by emitting `'error'`, and an `'error'` nobody is listening for is not a
 * failed write but a dead process. Every await here races the work against that
 * event, so the failure comes back as a rejection to whoever asked for the write.
 */
export function guardWrites(out: Writable): GuardedWrites {
  const failed = new Promise<never>((_, reject) => {
    out.once('error', reject)
  })
  // The race below is what reports the error; this only keeps node from calling it unhandled.
  failed.catch(() => undefined)

  const watch = <T>(work: Promise<T>): Promise<T> => Promise.race([failed, work])
  return {
    watch,
    write: (chunk) =>
      watch(
        new Promise<void>((resolve, reject) => {
          out.write(chunk, (error) => (error ? reject(error) : resolve()))
        })
      ),
    end: async () => {
      await watch(
        new Promise<void>((resolve, reject) => {
          out.end((error?: Error | null) => (error ? reject(error) : resolve()))
        })
      )
      // `end` has flushed what it knew of; closing the file comes after it, and a
      // failure there would otherwise be an error nobody awaited while a truncated
      // envelope was being renamed into place.
      await watch(finished(out))
    },
  }
}
