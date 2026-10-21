import {
  MemoryFileSystem,
  sha256,
  type AtomicStage,
  type ContentIdentity,
  type ChunkSource,
} from '../../src/index.js'
import { SimScheduler } from './scheduler.js'

interface Stage {
  path: string
  mtime: number
  base: ContentIdentity | null
  bytes: Uint8Array
  sealed: boolean
}
interface Disk {
  fs: MemoryFileSystem
  stages: Map<string, Stage>
  dirs: Map<string, string>
}

/** Durable disk and stage table; handles belong to one process epoch. */
export class MemoryStreamingFS {
  readonly epoch: number
  readonly stages: Map<string, Stage>
  constructor(
    readonly scheduler: SimScheduler,
    private disk: Disk = { fs: new MemoryFileSystem(), stages: new Map(), dirs: new Map() }
  ) {
    this.epoch = scheduler.epoch
    this.stages = disk.stages
  }
  reopen() {
    return new MemoryStreamingFS(this.scheduler, this.disk)
  }
  private point(label: string) {
    return this.scheduler.point(`fs.${label}`, this.epoch)
  }
  async *list() {
    await this.point('list')
    yield* this.disk.fs.list()
  }
  async *listDirectories() {
    await this.point('listDirectories')
    for (const [path, identity] of this.disk.dirs) yield { path, identity, mtime: 1 }
  }
  async listChildren(parent: string) {
    await this.point('listChildren')
    const prefix = parent ? parent + '/' : ''
    const immediate = (path: string) =>
      path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
    return [
      ...[...this.disk.dirs]
        .filter(([path]) => immediate(path))
        .map(([path, identity]) => ({ path, identity, kind: 'directory' as const })),
      ...[...this.disk.fs.snapshot().keys()]
        .filter(immediate)
        .map((path) => ({ path, kind: 'file' as const })),
    ]
  }
  async mkdir(path: string) {
    await this.point('mkdir')
    const parts = path.split('/')
    for (let n = 1; n <= parts.length; n++) {
      const parent = parts.slice(0, n).join('/')
      if (parent && !this.disk.dirs.has(parent)) this.disk.dirs.set(parent, this.scheduler.uuid())
    }
  }
  async removeDirectory(path: string, identity?: string) {
    await this.point('removeDirectory')
    if (identity && this.disk.dirs.get(path) !== identity)
      throw new Error('directory identity changed')
    if (
      [...this.disk.fs.snapshot().keys(), ...this.disk.dirs.keys()].some((p) =>
        p.startsWith(path + '/')
      )
    )
      throw new Error('directory not empty')
    this.disk.dirs.delete(path)
  }
  async moveDirectory(from: string, to: string) {
    await this.point('moveDirectory')
    if (this.disk.dirs.has(to)) throw new Error('destination exists')
    for (const path of this.disk.fs.snapshot().keys())
      if (path.startsWith(from + '/')) await this.disk.fs.move(path, to + path.slice(from.length))
    for (const [path, identity] of [...this.disk.dirs])
      if (path === from || path.startsWith(from + '/')) {
        this.disk.dirs.delete(path)
        this.disk.dirs.set(to + path.slice(from.length), identity)
      }
  }
  async read(path: string) {
    await this.point('read')
    return this.disk.fs.read(path)
  }
  async stat(path: string) {
    await this.point('stat')
    return this.disk.fs.stat(path)
  }
  async writeAtomic(path: string, bytes: Uint8Array, mtime: number) {
    await this.mkdir(path.split('/').slice(0, -1).join('/'))
    await this.point('writeAtomic')
    await this.disk.fs.writeAtomic(path, bytes, mtime)
  }
  async remove(path: string) {
    await this.point('remove')
    await this.disk.fs.remove(path)
  }
  async move(from: string, to: string) {
    await this.point('move')
    await this.disk.fs.move(from, to)
  }
  snapshot() {
    return this.disk.fs.snapshot()
  }
  async fingerprint(path: string) {
    const bytes = await this.read(path),
      info = await this.stat(path)
    return {
      size: bytes.length,
      sha: await sha256(bytes),
      mtime: info!.mtime,
      generation: `${info!.mtime}:${await sha256(bytes)}`,
    }
  }
  async openRead(path: string): Promise<ChunkSource> {
    await this.point('openRead')
    const bytes = await this.read(path)
    return {
      size: bytes.length,
      read: async (offset, length, signal) => {
        await this.point('source.read')
        signal?.throwIfAborted()
        return bytes.slice(offset, offset + length)
      },
      assertUnchanged: async () => {
        await this.point('source.assertUnchanged')
        if ((await sha256(await this.read(path))) !== (await sha256(bytes)))
          throw new Error('source changed')
      },
      close: async () => {
        await this.point('source.close')
      },
    }
  }
  async beginAtomicWrite(
    path: string,
    mtime: number,
    base: ContentIdentity | null,
    beforeCreate?: (stageId: string) => Promise<void>
  ): Promise<AtomicStage> {
    await this.point('beginAtomicWrite')
    const id = this.scheduler.uuid()
    await beforeCreate?.(id)
    this.scheduler.fence(this.epoch)
    this.stages.set(id, { path, mtime, base, bytes: new Uint8Array(), sealed: false })
    return this.handle(id)
  }
  async reopenStage(id: string) {
    await this.point('reopenStage')
    return this.handle(id)
  }
  async discardStage(id: string) {
    await this.point('stage.discard')
    this.stages.delete(id)
  }
  private handle(id: string): AtomicStage {
    const stage = this.stages.get(id)
    if (!stage) throw Object.assign(new Error('missing stage'), { code: 'ENOENT' })
    return {
      id,
      get offset() {
        return stage.bytes.length
      },
      append: async (offset, bytes, signal) => {
        await this.point('stage.append')
        signal?.throwIfAborted()
        if (stage.sealed || offset !== stage.bytes.length) throw new Error('invalid append')
        const next = new Uint8Array(offset + bytes.length)
        next.set(stage.bytes)
        next.set(bytes, offset)
        stage.bytes = next
      },
      seal: async (expected) => {
        await this.point('stage.seal')
        if (stage.bytes.length !== expected.size || (await sha256(stage.bytes)) !== expected.sha)
          throw new Error('stage integrity')
        this.scheduler.fence(this.epoch)
        stage.sealed = true
      },
      commit: async (signal) => {
        await this.mkdir(stage.path.split('/').slice(0, -1).join('/'))
        await this.point('stage.commit')
        signal?.throwIfAborted()
        if (!stage.sealed) throw new Error('unsealed stage')
        const current = await this.disk.fs.stat(stage.path)
        const sha = current ? await sha256(await this.disk.fs.read(stage.path)) : null
        this.scheduler.fence(this.epoch)
        if (sha !== (stage.base?.sha ?? null)) throw new Error('base changed')
        await this.disk.fs.writeAtomic(stage.path, stage.bytes, stage.mtime)
        this.stages.delete(id)
      },
      discard: () => this.discardStage(id),
    }
  }
}
