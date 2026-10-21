import { sha256 as createHash } from '@noble/hashes/sha256'

export const MAX_CHUNK_BYTES = 1024 * 1024
export const MAX_TEXT_BYTES = MAX_CHUNK_BYTES

export interface ContentIdentity {
  size: number
  sha: string
}
export interface SourceStamp {
  size: number
  mtime: number
  generation: string
}
export interface ChunkSource {
  readonly size: number
  readonly stamp?: SourceStamp
  readonly signal?: AbortSignal
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
  assertUnchanged(): Promise<void>
  close(): Promise<void>
}

export interface AtomicStage {
  /** True only when this stage installed the named inode/object, not equal user bytes. */
  installed?(): Promise<boolean>
  readonly id: string
  readonly offset: number
  append(offset: number, bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  seal(expected: ContentIdentity): Promise<void>
  commit(signal?: AbortSignal): Promise<void>
  discard(): Promise<void>
}

export interface StreamingFileSystem {
  openRead(path: string, expected?: SourceStamp): Promise<ChunkSource>
  fingerprint(path: string, signal?: AbortSignal): Promise<ContentIdentity & SourceStamp>
  beginAtomicWrite(
    path: string,
    mtime: number,
    expectedBase: (ContentIdentity & { mtime?: number }) | null,
    beforeCreate?: (stageId: string) => Promise<void>
  ): Promise<AtomicStage>
  reopenStage(id: string): Promise<AtomicStage>
  /** Idempotently discard a private stage, including an interrupted allocation. */
  discardStage?(id: string): Promise<void>
}

/** Retain an authenticated stage without publication, for verdict planning. */
export async function receiveToStage(
  source: ChunkSource,
  stage: AtomicStage,
  expected: ContentIdentity,
  budget: TransferBudget,
  signal?: AbortSignal
): Promise<void> {
  const receiving: AtomicStage = {
    id: stage.id,
    get offset() {
      return stage.offset
    },
    append: (offset, bytes, cancellation) => stage.append(offset, bytes, cancellation),
    seal: (identity) => stage.seal(identity),
    async commit() {},
    discard: () => stage.discard(),
  }
  await downloadToStage(source, receiving, expected, budget, signal)
}

/** Forward an authorized immutable version without assembling it or discarding the source. */
export async function forwardVersion(
  from: {
    openVersion(
      fileId: string,
      versionId: string,
      expected: ContentIdentity,
      signal?: AbortSignal
    ): Promise<ChunkSource>
  },
  to: {
    putBlobSource(
      expected: ContentIdentity,
      source: ChunkSource,
      signal?: AbortSignal,
      maxChunkBytes?: number
    ): Promise<void>
  },
  fileId: string,
  versionId: string,
  expected: ContentIdentity,
  budget: TransferBudget,
  signal?: AbortSignal
): Promise<void> {
  await budget.run(async () => {
    const source = await from.openVersion(fileId, versionId, expected, signal)
    let closed = false
    const owned: ChunkSource = {
      size: source.size,
      ...(source.stamp === undefined ? {} : { stamp: source.stamp }),
      ...(source.signal === undefined ? {} : { signal: source.signal }),
      read: (at, length, cancellation) => source.read(at, length, cancellation),
      assertUnchanged: () => source.assertUnchanged(),
      close: async () => {
        if (!closed) {
          closed = true
          await source.close()
        }
      },
    }
    try {
      await to.putBlobSource(expected, owned, signal ?? source.signal, budget.maxChunkBytes)
    } finally {
      await owned.close()
    }
  }, signal)
}

/** Downloads and verifies before publishing; errors leave the journal-owned stage intact. */
export async function downloadToStage(
  source: ChunkSource,
  stage: AtomicStage,
  expected: ContentIdentity,
  budget: TransferBudget,
  signal?: AbortSignal,
  beforeCommit?: () => Promise<void>
): Promise<void> {
  signal ??= source.signal
  let entered = false
  try {
    await budget.run(async () => {
      entered = true
      try {
        let offset = stage.offset
        const start = offset
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > source.size ||
          source.size !== expected.size
        )
          throw new Error('invalid stage offset or source size')
        const suffix: ChunkSource = {
          size: source.size - start,
          read: (at, length, cancellation) => source.read(start + at, length, cancellation),
          assertUnchanged: () => source.assertUnchanged(),
          async close() {},
        }
        for await (const bytes of chunks(suffix, budget.maxChunkBytes, signal)) {
          await stage.append(offset, bytes, signal)
          offset += bytes.length
        }
        signal?.throwIfAborted()
        await stage.seal(expected)
        await beforeCommit?.()
        signal?.throwIfAborted()
        await stage.commit(signal)
      } finally {
        await source.close()
      }
    }, signal)
  } finally {
    if (!entered) await source.close()
  }
}

/** Owns the source. No read-ahead; even early generator return closes the handle. */
export async function* chunks(
  source: ChunkSource,
  chunkBytes = MAX_CHUNK_BYTES,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  try {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES)
      throw new Error('invalid chunk size')
    if (!Number.isSafeInteger(source.size) || source.size < 0)
      throw new Error('invalid source size')
    signal?.throwIfAborted()
    for (let offset = 0; offset < source.size;) {
      signal?.throwIfAborted()
      const length = Math.min(chunkBytes, source.size - offset)
      const bytes = await source.read(offset, length, signal)
      signal?.throwIfAborted()
      if (bytes.byteLength !== length || bytes.buffer.byteLength > MAX_CHUNK_BYTES)
        throw new Error('invalid chunk length or backing buffer')
      yield bytes
      offset += length
    }
    await source.assertUnchanged()
  } finally {
    await source.close()
  }
}

export async function fingerprintSource(
  source: ChunkSource,
  chunkBytes = MAX_CHUNK_BYTES,
  signal?: AbortSignal
): Promise<ContentIdentity> {
  const hash = createHash.create()
  let size = 0
  for await (const bytes of chunks(source, chunkBytes, signal)) {
    hash.update(bytes)
    size += bytes.length
  }
  return {
    size,
    sha: Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  }
}

/** Share one instance across all transfers belonging to an engine/host. */
export class TransferBudget {
  readonly maxChunkBytes: number
  readonly maxActiveTransfers: number
  private active = 0
  private readonly queue: Array<() => void> = []
  constructor(options: { maxChunkBytes?: number; maxActiveTransfers?: number } = {}) {
    this.maxChunkBytes = options.maxChunkBytes ?? MAX_CHUNK_BYTES
    this.maxActiveTransfers = options.maxActiveTransfers ?? 2
    if (
      !Number.isSafeInteger(this.maxChunkBytes) ||
      this.maxChunkBytes < 1 ||
      this.maxChunkBytes > MAX_CHUNK_BYTES ||
      !Number.isSafeInteger(this.maxActiveTransfers) ||
      this.maxActiveTransfers < 1
    )
      throw new Error('invalid transfer budget')
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const enter = () => {
        signal?.removeEventListener('abort', abort)
        this.active++
        resolve()
      }
      const abort = () => {
        const index = this.queue.indexOf(enter)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal?.reason ?? new Error('cancelled'))
      }
      if (this.active < this.maxActiveTransfers) enter()
      else {
        this.queue.push(enter)
        signal?.addEventListener('abort', abort, { once: true })
      }
    })
    try {
      signal?.throwIfAborted()
      return await work()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}
