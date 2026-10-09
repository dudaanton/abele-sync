import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { EngineError, sha256, type FileInfo, type FileSystem } from '@abele/sync-core'
import { NodeFileSystem, type NodeFileSystemOptions } from './nodeFs.js'

export interface Image {
  sha: string
  size: number
  mtime: number
}
export type Images = Record<string, Image | null>
export type GroupOp =
  | { kind: 'write'; path: string; image: Image }
  | { kind: 'remove'; path: string }
  | { kind: 'move'; from: string; to: string }
export interface GroupStep {
  op: GroupOp
  before: Images
  after: Images
}

export const sameImage = (a: Image | null, b: Image | null): boolean =>
  a === null || b === null ? a === b : a.sha === b.sha && a.size === b.size && a.mtime === b.mtime

/** One immutable blob at a time on disk, rather than keeping an entire plugin group in RAM. */
export class GroupBlobs {
  constructor(readonly fs: NodeFileSystem) {}
  async save(bytes: Uint8Array): Promise<string> {
    const sha = await sha256(bytes)
    await this.fs.writeAtomic(sha, bytes, 0)
    return sha
  }
  async read(image: Image): Promise<Uint8Array> {
    const bytes = await this.fs.read(image.sha)
    if (bytes.length !== image.size || (await sha256(bytes)) !== image.sha) {
      throw new EngineError('conflict', 'code approval cache is damaged; nothing restored from it')
    }
    return bytes
  }
}

/** A stable image, including absence. The content hash catches edits that preserve timestamps. */
export async function imageOf(
  fs: FileSystem,
  path: string,
  blobs?: GroupBlobs
): Promise<Image | null> {
  const before = await fs.stat(path)
  if (before === null) return null
  const bytes = await fs.read(path)
  const after = await fs.stat(path)
  if (
    after === null ||
    before.size !== after.size ||
    before.mtime !== after.mtime ||
    bytes.length !== before.size
  ) {
    throw new EngineError('conflict', `code changed while reading ${path}`)
  }
  const sha = blobs === undefined ? await sha256(bytes) : await blobs.save(bytes)
  return { sha, size: bytes.length, mtime: before.mtime }
}

/** Speculative filesystem: every download and every pull placement runs here, never in the vault. */
export class CodeDraft implements FileSystem {
  readonly steps: GroupStep[] = []
  readonly observed = new Map<string, Image | null>()
  private constructor(
    private readonly real: FileSystem,
    private readonly view: NodeFileSystem,
    readonly blobs: GroupBlobs
  ) {}

  static async create(
    real: FileSystem,
    work: string,
    options: NodeFileSystemOptions = {}
  ): Promise<CodeDraft> {
    options.effectGuard?.()
    await mkdir(join(work, 'view'))
    options.effectGuard?.()
    await mkdir(join(work, 'blobs'))
    return new CodeDraft(
      real,
      new NodeFileSystem(join(work, 'view'), options),
      new GroupBlobs(new NodeFileSystem(join(work, 'blobs'), options))
    )
  }

  async preload(paths: Iterable<string>): Promise<void> {
    for (const path of paths) await this.load(path)
  }
  private async load(path: string): Promise<void> {
    if (this.observed.has(path)) return
    const image = await imageOf(this.real, path, this.blobs)
    this.observed.set(path, image)
    if (image !== null && (await this.view.stat(path)) === null) {
      await this.view.writeAtomic(path, await this.blobs.read(image), image.mtime)
    }
  }
  async *list(): AsyncIterable<FileInfo> {
    yield* this.view.list()
  }
  async stat(path: string): Promise<FileInfo | null> {
    await this.load(path)
    return this.view.stat(path)
  }
  async read(path: string): Promise<Uint8Array> {
    await this.load(path)
    return this.view.read(path)
  }
  async writeAtomic(path: string, bytes: Uint8Array, mtime: number): Promise<void> {
    await this.load(path)
    const before = { [path]: await imageOf(this.view, path, this.blobs) }
    await this.view.writeAtomic(path, bytes, mtime)
    const image = (await imageOf(this.view, path, this.blobs))!
    this.steps.push({ op: { kind: 'write', path, image }, before, after: { [path]: image } })
  }
  async remove(path: string): Promise<void> {
    await this.load(path)
    const before = { [path]: await imageOf(this.view, path, this.blobs) }
    await this.view.remove(path)
    this.steps.push({ op: { kind: 'remove', path }, before, after: { [path]: null } })
  }
  async move(from: string, to: string): Promise<void> {
    await this.preload([from, to])
    const before = {
      [from]: await imageOf(this.view, from, this.blobs),
      [to]: await imageOf(this.view, to, this.blobs),
    }
    await this.view.move(from, to)
    this.steps.push({
      op: { kind: 'move', from, to },
      before,
      after: {
        [from]: await imageOf(this.view, from, this.blobs),
        [to]: await imageOf(this.view, to, this.blobs),
      },
    })
  }

  async validateResult(): Promise<boolean> {
    const paths = new Set(this.steps.flatMap((step) => Object.keys(step.after)))
    for (const path of paths) {
      if (!sameImage(await imageOf(this.view, path), await imageOf(this.real, path))) return false
    }
    return true
  }

  /** After ALL downloads, immediately before installation; no observation becomes write permission. */
  async validate(): Promise<boolean> {
    for (const [path, before] of this.observed) {
      if (!sameImage(before, await imageOf(this.real, path))) return false
    }
    return true
  }
}
