import {
  AbeleError,
  V2CommitOpSchema,
  PathSchema,
  type V2CommitOp,
  type V2ManifestItem,
  type CommitOpResult,
} from '@abele/sync-protocol'
import { z } from 'zod'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'

const KEY = 'v2-directories'
const DocumentSchema = z
  .object({
    directories: z.array(
      z
        .object({
          file_id: z.string().min(1),
          version_id: z.string().min(1),
          path: PathSchema,
          kind: z.literal('directory'),
          mtime: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          identity: z.string().min(1),
        })
        .strict()
    ),
    pending: z
      .object({ key: z.string().min(1), op: V2CommitOpSchema, identity: z.string().min(1) })
      .strict()
      .optional(),
    removals: z.array(z.string().min(1)),
  })
  .strict()
type DirectoryItem = Extract<V2ManifestItem, { kind: 'directory' }>
interface LocalDirectory extends DirectoryItem {
  identity: string
}
interface Document {
  directories: LocalDirectory[]
  pending?: { key: string; op: V2CommitOp; identity: string }
  removals: string[]
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
    await this.fs.mkdir(item.path)
    const local: Array<{ path: string; identity: string; mtime: number }> = []
    for await (const dir of this.fs.listDirectories()) local.push(dir)
    const identity = local.find((d) => d.path === item.path)!.identity
    if (old && old.path !== item.path) doc.removals.push(old.path)
    doc.directories = doc.directories.filter((d) => d.file_id !== item.file_id)
    doc.directories.push({ ...item, identity })
    await this.save(doc)
  }
  async departed(fileId: string, keep = false) {
    const doc = await this.read()
    const old = doc.directories.find((d) => d.file_id === fileId)
    if (!old) return false
    doc.directories = doc.directories.filter((d) => d.file_id !== fileId)
    if (!keep) doc.removals.push(old.path)
    await this.save(doc)
    return true
  }
  async finishPull() {
    if (!this.fs.removeDirectory) return
    const doc = await this.read()
    for (const path of [...new Set(doc.removals)].sort((a, b) => b.length - a.length)) {
      try {
        await this.fs.removeDirectory(path)
      } catch (error) {
        // Empty-only cleanup is best effort when unsent/local-only children remain.
        const code = (error as { code?: string } | null)?.code
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      }
      doc.removals = doc.removals.filter((p) => p !== path)
      await this.save(doc)
    }
  }
  async scan() {
    if (!this.fs.listDirectories) return
    const doc = await this.read()
    const record = async (pending: NonNullable<Document['pending']>) => {
      const result = (await this.commit([pending.op], pending.key))[0]!
      if (result.status === 'rejected') {
        delete doc.pending
        await this.save(doc)
        if (result.code === 'not_found' || result.code === 'invalid_request') return false
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
        })
      }
      delete doc.pending
      await this.save(doc)
      return true
    }
    if (doc.pending && !(await record(doc.pending))) return
    const local: Array<{ path: string; identity: string; mtime: number }> = []
    for await (const dir of this.fs.listDirectories()) if (this.includes(dir.path)) local.push(dir)
    const missing = doc.directories.filter(
      (d) => this.includes(d.path) && !local.some((l) => l.path === d.path)
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
            to_path: moved.path,
          }
        : { op: 'delete_directory', file_id: old.file_id, base_version_id: old.version_id }
      doc.pending = { key: crypto.randomUUID(), op, identity: moved?.identity ?? old.identity }
      await this.save(doc)
      if (!(await record(doc.pending))) return
      // Descendant versions are supplied by the following feed; don't send stale bases.
      if (moved) {
        for (const child of doc.directories)
          if (child.path.startsWith(old.path + '/'))
            child.path = moved.path + child.path.slice(old.path.length)
      } else doc.directories = doc.directories.filter((d) => !d.path.startsWith(old.path + '/'))
      await this.save(doc)
    }
    for (const dir of local.sort((a, b) => a.path.length - b.path.length)) {
      if (doc.directories.some((d) => d.path === dir.path)) continue
      doc.pending = {
        key: crypto.randomUUID(),
        op: { op: 'mkdir', path: dir.path, mtime: dir.mtime },
        identity: dir.identity,
      }
      await this.save(doc)
      await record(doc.pending)
    }
  }
}
