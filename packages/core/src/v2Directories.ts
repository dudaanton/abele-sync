import {
  AbeleError,
  V2CommitOpSchema,
  V2ManifestItemSchema,
  PathSchema,
  type V2CommitOp,
  type V2ManifestItem,
  type CommitOpResult,
} from '@abele/sync-protocol'
import { z } from 'zod'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'
import { LocalPaths, wirePath } from './localPaths.js'

const KEY = 'v2-directories'
const DocumentSchema = z
  .object({
    schemaVersion: z.literal(2).optional(),
    incoming: z.array(V2ManifestItemSchema).optional(),
    directories: z.array(
      z
        .object({
          file_id: z.string().min(1),
          version_id: z.string().min(1),
          path: PathSchema,
          kind: z.literal('directory'),
          mtime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          identity: z.string().min(1),
          localPath: z.string().min(1).optional(),
        })
        .strict()
    ),
    pending: z
      .object({
        key: z.string().min(1),
        op: V2CommitOpSchema,
        identity: z.string().min(1),
        localPath: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    removals: z.array(
      z.union([
        z.string().min(1),
        z
          .object({ localPath: z.string().min(1), identity: z.string().min(1), path: PathSchema })
          .strict(),
      ])
    ),
  })
  .strict()
type DirectoryItem = Extract<V2ManifestItem, { kind: 'directory' }>
interface LocalDirectory extends DirectoryItem {
  identity: string
  localPath?: string
}
interface Document {
  schemaVersion?: 2
  incoming?: V2ManifestItem[]
  directories: LocalDirectory[]
  pending?: { key: string; op: V2CommitOp; identity: string; localPath?: string }
  removals: Array<string | { localPath: string; identity: string; path: string }>
}

/** Directory operations share the engine's durable state and idempotent commit transport.
 * The journal precedes the request; uncertain responses replay the identical operation.
 * Remote directory deletion only removes empty folders, never unsynced bytes recursively. */
export class V2Directories {
  constructor(
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly includes: (path: string) => boolean,
    private readonly commit: (ops: V2CommitOp[], key: string) => Promise<CommitOpResult[]>
  ) {}
  private async read(): Promise<Document> {
    const raw = await this.state.getMeta!(KEY)
    return raw === null
      ? { directories: [], removals: [] }
      : (DocumentSchema.parse(JSON.parse(raw)) as Document)
  }
  private save(doc: Document) {
    doc.schemaVersion = 2
    return this.state.setMeta!(KEY, JSON.stringify(doc))
  }
  async receive(item: DirectoryItem) {
    if (!this.includes(item.path)) return
    if (!this.fs.mkdir || !this.fs.listDirectories)
      throw new AbeleError('invalid_request', 'host directory filesystem ports are required')
    const doc = await this.read()
    const old = doc.directories.find((d) => d.file_id === item.file_id)
    // Place the destination, then let file events move only tracked content. Moving
    // the entire source directory would relocate unsent bytes and local-only folders.
    const inventory = await LocalPaths.forPath(this.fs, item.path, this.state)
    if (inventory.blocked(item.path)) {
      doc.incoming = [...(doc.incoming ?? []).filter((d) => d.file_id !== item.file_id), item]
      await this.save(doc)
      return
    }
    const target = inventory.resolve(item.path, 'directory')
    await this.fs.mkdir(target)
    let after = await LocalPaths.forPath(this.fs, item.path, this.state)
    let placed = after.directory(after.resolve(item.path, 'directory'))
    if (!placed && old && this.fs.moveDirectory) {
      // On an insensitive host mkdir may address the old case spelling. Only the
      // tracked physical identity authorizes respelling that one directory.
      const alias = after.directoryCaseAlias(target, old.identity)
      if (alias) {
        await this.fs.moveDirectory(alias.path, target)
        after = await LocalPaths.forPath(this.fs, item.path, this.state)
        placed = after.directory(after.resolve(item.path, 'directory'))
      }
    }
    if (!placed) throw new AbeleError('invalid_request', 'created directory missing from inventory')
    const identity = placed.identity!
    if (old && old.path !== item.path && old.identity !== identity)
      doc.removals.push({
        localPath: old.localPath ?? old.path,
        identity: old.identity,
        path: old.path,
      })
    doc.directories = doc.directories.filter((d) => d.file_id !== item.file_id)
    doc.directories.push({ ...item, identity, localPath: placed.path })
    doc.incoming = (doc.incoming ?? []).filter((d) => d.file_id !== item.file_id)
    await this.save(doc)
  }
  async departed(fileId: string, keep = false) {
    const doc = await this.read()
    doc.incoming = (doc.incoming ?? []).filter((d) => d.file_id !== fileId)
    const old = doc.directories.find((d) => d.file_id === fileId)
    if (!old) {
      await this.save(doc)
      return false
    }
    doc.directories = doc.directories.filter((d) => d.file_id !== fileId)
    if (!keep)
      doc.removals.push({
        localPath: old.localPath ?? old.path,
        identity: old.identity,
        path: old.path,
      })
    await this.save(doc)
    return true
  }
  async finishPull() {
    if (!this.fs.removeDirectory) return
    const doc = await this.read()
    const localPath = (removal: Document['removals'][number]) =>
      typeof removal === 'string' ? removal : removal.localPath
    for (const removal of [...doc.removals].sort(
      (a, b) => localPath(b).length - localPath(a).length
    )) {
      const path = localPath(removal)
      // Legacy cleanup lacks identity evidence. Preserve it for review rather than
      // deleting whatever now occupies the spelling after an upgrade.
      if (typeof removal === 'string') continue
      if (doc.directories.some((directory) => directory.identity === removal.identity)) {
        // Older runs may have queued the previous case spelling of this same
        // physical directory. It is still live, including when it is empty.
        doc.removals = doc.removals.filter((entry) => entry !== removal)
        await this.save(doc)
        continue
      }
      const inventory = await LocalPaths.forPath(this.fs, removal.path, this.state)
      if (inventory.blocked(removal.path)) continue
      const identity = inventory.directory(path)?.identity
      if (identity !== undefined && identity !== removal.identity) continue
      if (inventory.resolve(removal.path, 'directory') !== path && identity !== undefined) continue
      try {
        await this.fs.removeDirectory(path, removal.identity)
      } catch (error) {
        // Empty-only cleanup is best effort when unsent/local-only children remain.
        const code = (error as { code?: string } | null)?.code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      }
      doc.removals = doc.removals.filter((p) => p !== removal)
      await this.save(doc)
    }
  }
  async scan() {
    if (!this.fs.listDirectories) return
    const waiting = await this.read()
    for (const item of waiting.incoming ?? [])
      if (item.kind === 'directory') await this.receive(item)
    const doc = await this.read()
    const beforeReplay = await LocalPaths.read(this.fs, this.state)
    if (doc.pending) {
      const op = doc.pending.op
      const path =
        op.op === 'mkdir'
          ? op.path
          : op.op === 'move_directory'
            ? op.to_path
            : 'file_id' in op
              ? doc.directories.find((d) => d.file_id === op.file_id)?.path
              : undefined
      if (path && beforeReplay.blocked(path)) return
      if (
        path &&
        op.op === 'delete_directory' &&
        beforeReplay.directory(beforeReplay.resolve(path, 'directory'))
      ) {
        // The request may already have been submitted. Preserve its exact evidence,
        // but do not replay recursive deletion over a directory that is present now.
        throw new AbeleError(
          'invalid_request',
          `pending directory deletion needs review: occupied canonical path ${path}`
        )
      }
    }
    const record = async (pending: NonNullable<Document['pending']>) => {
      let result: CommitOpResult
      try {
        result = (await this.commit([pending.op], pending.key))[0]!
      } catch (error) {
        // Only a definitive validator rejection retires the immutable request.
        // Network failures and uncertain outcomes keep the original key and bytes.
        if (!(error instanceof AbeleError) || error.code !== 'invalid_path') throw error
        delete doc.pending
        await this.save(doc)
        return false
      }
      if (result.status === 'rejected') {
        delete doc.pending
        await this.save(doc)
        if (
          result.code === 'not_found' ||
          result.code === 'invalid_request' ||
          result.code === 'invalid_path'
        )
          return false
        throw new AbeleError(result.code, `${result.message}: ${JSON.stringify(pending.op)}`)
      }
      if (pending.op.op === 'delete_directory') {
        doc.directories = doc.directories.filter((d) => d.file_id !== result.file_id)
      } else {
        doc.directories = doc.directories.filter((d) => d.file_id !== result.file_id)
        doc.directories.push({
          file_id: result.file_id,
          version_id: result.version_id,
          path: result.path,
          kind: 'directory',
          mtime: result.mtime,
          identity: pending.identity,
          localPath: pending.localPath ?? result.path,
        })
      }
      delete doc.pending
      await this.save(doc)
      return true
    }
    if (doc.pending && !(await record(doc.pending))) return
    const local: Array<{ path: string; identity: string; mtime: number }> = []
    const inventory = beforeReplay
    for await (const dir of this.fs.listDirectories()) {
      const path = wirePath(dir.path)
      if (this.includes(path) && !inventory.blocked(path)) {
        inventory.resolve(path, 'directory')
        local.push(dir)
      }
    }
    // Occupancy owns the wire identity. A host may replace a directory inode while
    // retaining its contents; that is not authority to recursively delete the server tree.
    // Identity is only rename evidence when the canonical source path is absent.
    for (const old of doc.directories) {
      const current = local.find((l) => wirePath(l.path) === old.path)
      if (current) {
        old.localPath = current.path
        old.identity = current.identity
      }
    }
    await this.save(doc)
    const missing = doc.directories.filter(
      (d) =>
        this.includes(d.path) &&
        !inventory.blocked(d.path) &&
        !local.some((l) => wirePath(l.path) === d.path)
    )
    // Parents first: a server tree operation updates the identities of descendants.
    const roots = missing.filter(
      (old) => !missing.some((parent) => parent !== old && old.path.startsWith(parent.path + '/'))
    )
    for (const old of roots.sort((a, b) => a.path.length - b.path.length)) {
      const moved = local.find((l) => l.identity === old.identity)
      // A widened/reset scope needs its snapshot before absence is a deletion.
      // The next ordinary cycle can delete missing folders on a known baseline.
      if (!moved && (await this.state.getCursor()) === 0) continue
      const op: V2CommitOp = moved
        ? {
            op: 'move_directory',
            file_id: old.file_id,
            base_version_id: old.version_id,
            to_path: wirePath(moved.path),
          }
        : { op: 'delete_directory', file_id: old.file_id, base_version_id: old.version_id }
      doc.pending = {
        key: crypto.randomUUID(),
        op,
        identity: moved?.identity ?? old.identity,
        localPath: moved?.path ?? old.localPath ?? old.path,
      }
      await this.save(doc)
      if (!(await record(doc.pending))) return
      // Descendant versions are supplied by the following feed; don't send stale bases.
      if (moved) {
        for (const child of doc.directories)
          if (child.path.startsWith(old.path + '/'))
            child.path = wirePath(moved.path) + child.path.slice(old.path.length)
      } else doc.directories = doc.directories.filter((d) => !d.path.startsWith(old.path + '/'))
      await this.save(doc)
    }
    for (const dir of local.sort((a, b) => a.path.length - b.path.length)) {
      if (doc.directories.some((d) => d.path === wirePath(dir.path))) continue
      doc.pending = {
        key: crypto.randomUUID(),
        op: { op: 'mkdir', path: wirePath(dir.path), mtime: dir.mtime },
        identity: dir.identity,
        localPath: dir.path,
      }
      await this.save(doc)
      await record(doc.pending)
    }
  }
}
