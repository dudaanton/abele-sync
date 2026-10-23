import { replayAuthority } from './replayAuthority.js'
import { transact } from './stateTransaction.js'
import {
  AbeleError,
  caseKey,
  V2CommitOpSchema,
  V2ManifestItemSchema,
  PathSchema,
  ErrorCodeSchema,
  type V2CommitOp,
  type V2ManifestItem,
  type CommitOpResult,
} from '@abele/sync-protocol'
import type { Refusal } from './pusher.js'
import { z } from 'zod'
import type { FileSystem } from './fs.js'
import type { StateEntry, StateStore } from './state.js'
import { LocalPaths, wirePath } from './localPaths.js'
import { fingerprintFile } from './fs.js'
import { sha256 } from './hash.js'

const KEY = 'v2-directories'
const DocumentSchema = z
  .object({
    schemaVersion: z.literal(2).optional(),
    incoming: z.array(V2ManifestItemSchema).optional(),
    refused: z
      .array(
        z
          .object({
            path: PathSchema,
            code: ErrorCodeSchema,
            message: z.string(),
            direction: z.enum(['push', 'pull']),
            evidence: z.literal(true).optional(),
            source: PathSchema.optional(),
            candidateIdentity: z.string().min(1).optional(),
          })
          .strict()
      )
      .optional(),
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
  refused?: DirectoryRefusal[]
  directories: LocalDirectory[]
  pending?: { key: string; op: V2CommitOp; identity: string; localPath?: string }
  removals: Array<string | { localPath: string; identity: string; path: string }>
}

export interface DirectoryRefusal extends Refusal {
  path: string
  direction: 'push' | 'pull'
  /** Recomputed on every directory scan, unlike an explicit server refusal. */
  evidence?: true
  source?: string
  candidateIdentity?: string
}

/** Scanner protection shares the same durable image as the directory decision. */
export async function heldDirectoryPaths(state: StateStore): Promise<Set<string>> {
  const raw = await state.getMeta?.(KEY)
  if (raw == null) return new Set()
  const doc = DocumentSchema.parse(JSON.parse(raw))
  return new Set(doc.refused?.filter((row) => row.evidence).map((row) => row.path))
}

// These codes are item refusals in an op result or a host mkdir. HTTP forbidden
// still revokes connection authority and must abort rather than suppress a path.
const refusalCodes = new Set([
  'quota_exceeded',
  'leaves_scope',
  'invalid_path',
  'too_large',
  'scripts_forbidden',
  'path_taken',
  'case_collision',
  'forbidden',
])
function itemRefusal(error: unknown): error is AbeleError {
  return error instanceof AbeleError && refusalCodes.has(error.code)
}

/** Directory operations share the engine's durable state and idempotent commit transport.
 * The journal precedes the request; uncertain responses replay the identical operation.
 * Remote directory deletion only removes empty folders, never unsynced bytes recursively. */
export class V2Directories {
  private refused: DirectoryRefusal[] = []
  private readonly refusedPaths = new Map<string, DirectoryRefusal>()
  constructor(
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly includes: (path: string) => boolean,
    private readonly commit: (ops: V2CommitOp[], key: string) => Promise<CommitOpResult[]>,
    private readonly signal?: AbortSignal
  ) {}
  private async read(): Promise<Document> {
    const raw = await this.state.getMeta!(KEY)
    const doc =
      raw === null
        ? { directories: [], removals: [] }
        : (DocumentSchema.parse(JSON.parse(raw)) as Document)
    this.indexRefusals(doc.refused ?? [])
    return doc
  }
  private save(doc: Document, state: StateStore = this.state) {
    doc.schemaVersion = 2
    this.indexRefusals(doc.refused ?? [])
    return state.setMeta!(KEY, JSON.stringify(doc))
  }
  async loadRefusals(retry = false, paths?: readonly string[]): Promise<void> {
    const doc = await this.read()
    if (retry && doc.refused?.length) {
      doc.refused = doc.refused.filter(
        (item) => item.evidence || (paths !== undefined && !paths.includes(item.path))
      )
      await this.save(doc)
    }
  }
  refusalFor(path: string): DirectoryRefusal | undefined {
    path = wirePath(path)
    // Cost follows path depth, not the number of refused folders times every file.
    for (;;) {
      const refusal = this.refusedPaths.get(path)
      if (refusal) return refusal
      const slash = path.lastIndexOf('/')
      if (slash < 0) return undefined
      path = path.slice(0, slash)
    }
  }
  private indexRefusals(items: DirectoryRefusal[]) {
    this.refused = items
    this.refusedPaths.clear()
    for (const item of items) this.refusedPaths.set(item.path, item)
  }
  refusals(): readonly DirectoryRefusal[] {
    return this.refused
  }
  private refuse(doc: Document, path: string, error: Refusal, direction: 'push' | 'pull') {
    doc.refused = [
      ...(doc.refused ?? []).filter((item) => item.path !== path),
      { path, code: error.code, message: error.message, direction },
    ]
  }
  async receive(item: DirectoryItem) {
    this.signal?.throwIfAborted()
    if (!this.includes(item.path)) return
    if (!this.fs.mkdir || !this.fs.listDirectories)
      throw new AbeleError('invalid_request', 'host directory filesystem ports are required')
    const doc = await this.read()
    const previousIncoming = doc.incoming?.find((directory) => directory.file_id === item.file_id)
    if (previousIncoming && previousIncoming.path !== item.path) {
      doc.refused = doc.refused?.filter((entry) => entry.path !== previousIncoming.path)
      this.indexRefusals(doc.refused ?? [])
    }
    if (this.refusalFor(item.path)?.direction === 'pull') {
      // Keep the latest identity without retrying mkdir. A delayed departure of an
      // older directory at this spelling must not retire the replacement's refusal.
      doc.incoming = [
        ...(doc.incoming ?? []).filter((d) => d.file_id !== item.file_id && d.path !== item.path),
        item,
      ]
      await this.save(doc)
      return
    }
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
    try {
      await this.fs.mkdir(target)
    } catch (error) {
      if (!itemRefusal(error)) throw error
      this.refuse(doc, item.path, error, 'pull')
      doc.incoming = [...(doc.incoming ?? []).filter((d) => d.file_id !== item.file_id), item]
      await this.save(doc)
      return
    }
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
    // A remote directory now exists: an earlier refused publication is satisfied.
    doc.refused = doc.refused?.filter((entry) => entry.path !== item.path)
    doc.incoming = (doc.incoming ?? []).filter((d) => d.file_id !== item.file_id)
    await this.save(doc)
  }
  async departed(fileId: string, keep = false) {
    const doc = await this.read()
    const waiting = doc.incoming?.find((item) => item.file_id === fileId)
    if (waiting?.kind === 'directory')
      doc.refused = doc.refused?.filter((item) => item.path !== waiting.path)
    doc.incoming = (doc.incoming ?? []).filter((d) => d.file_id !== fileId)
    const old = doc.directories.find((d) => d.file_id === fileId)
    if (!old) {
      await this.save(doc)
      return waiting?.kind === 'directory'
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
      this.signal?.throwIfAborted()
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
    if (await this.retireRecreatedDelete()) return
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
        await this.retireRecreatedDelete()
        return
      }
    }
    const emptyRefusal = async (pending: NonNullable<Document['pending']>, error: Refusal) => {
      const op = pending.op
      if (!('empty_only' in op) || !op.empty_only || error.code !== 'conflict') return false
      const source = doc.directories.find((dir) => dir.file_id === op.file_id)
      for (const path of [source?.path, op.op === 'move_directory' ? op.to_path : undefined]) {
        if (path === undefined) continue
        this.refuse(doc, path, error, 'push')
        doc.refused!.find((row) => row.path === path)!.evidence = true
        doc.refused!.find((row) => row.path === path)!.source = source?.path
      }
      delete doc.pending
      await this.save(doc)
      return true
    }
    const record = async (pending: NonNullable<Document['pending']>) => {
      this.signal?.throwIfAborted()
      let result: CommitOpResult
      try {
        result = (await this.commit([pending.op], pending.key))[0]!
      } catch (error) {
        if (error instanceof AbeleError && (await emptyRefusal(pending, error))) return false
        // Only a definitive validator rejection retires the immutable request.
        // Network failures and uncertain outcomes keep the original key and bytes.
        if (pending.op.op === 'mkdir' && itemRefusal(error) && error.code !== 'forbidden') {
          this.refuse(doc, pending.op.path, error, 'push')
          delete doc.pending
          await this.save(doc)
          return false
        }
        if (!(error instanceof AbeleError) || error.code !== 'invalid_path') throw error
        delete doc.pending
        await this.save(doc)
        return false
      }
      // The server answer resolves the immutable request, not a newer local
      // directory baseline received while that request was awaiting settlement.
      const latest = await this.read()
      if (latest.pending?.key !== pending.key) return false
      Object.assign(doc, latest)
      if (result.status === 'rejected') {
        if (await emptyRefusal(pending, result)) return false
        if (pending.op.op === 'mkdir' && refusalCodes.has(result.code)) {
          this.refuse(doc, pending.op.path, result, 'push')
          delete doc.pending
          await this.save(doc)
          return false
        }
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
      const current = doc.directories.find((directory) => directory.file_id === result.file_id)
      const identity = (d: typeof current) =>
        d ? { fileId: d.file_id, versionId: d.version_id } : null
      const expected =
        pending.op.op === 'mkdir'
          ? null
          : 'base_version_id' in pending.op
            ? { fileId: result.file_id, versionId: pending.op.base_version_id }
            : null
      const sameBase = replayAuthority(
        result.file_id,
        expected,
        identity(current),
        identity(
          doc.directories.find(
            (d) =>
              d.file_id !== result.file_id &&
              (this.fs.pathKey?.(d.path) ?? caseKey(d.path)) ===
                (this.fs.pathKey?.(result.path) ?? caseKey(result.path))
          ) ?? current
        )
      )
      if (
        current?.version_id === result.version_id ||
        !sameBase ||
        (current === undefined && (await this.state.getCursor()) > result.seq)
      ) {
        delete doc.pending
        await this.save(doc)
        return false
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
    const pending = doc.pending
    if (
      pending &&
      !(await record(pending)) &&
      !(pending.op.op === 'mkdir' && this.refusalFor(pending.op.path))
    )
      return
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
    const previousEvidence = (doc.refused ?? []).filter((row) => row.evidence)
    const previousCandidates = new Map<string, Set<string>>()
    for (const row of doc.refused ?? []) {
      if (!row.evidence || !row.source || row.path === row.source) continue
      const candidates = previousCandidates.get(row.source) ?? new Set<string>()
      candidates.add(row.path)
      previousCandidates.set(row.source, candidates)
    }
    const wasCandidate = (source: string, dir: (typeof local)[number]) =>
      previousCandidates.get(source)?.has(wirePath(dir.path)) ||
      previousEvidence.some(
        (row) => row.source === source && row.candidateIdentity === dir.identity
      )
    const hasPreviousCandidate = (source: string) =>
      local.some((dir) => wirePath(dir.path) !== source && wasCandidate(source, dir))
    for (const old of doc.directories) {
      const current = local.find((l) => wirePath(l.path) === old.path)
      if (current) {
        // A newly recreated source name cannot erase evidence of the original
        // object still waiting at its candidate path.
        if (hasPreviousCandidate(old.path)) continue
        old.localPath = current.path
        old.identity = current.identity
      }
    }
    doc.refused = doc.refused?.filter(
      (item) =>
        !item.evidence &&
        (item.direction === 'pull' || local.some((dir) => wirePath(dir.path) === item.path))
    )
    const missing = doc.directories.filter(
      (d) =>
        this.includes(d.path) &&
        !inventory.blocked(d.path) &&
        (!local.some((l) => wirePath(l.path) === d.path) || hasPreviousCandidate(d.path))
    )
    // Parents first: a server tree operation updates the identities of descendants.
    const roots = missing.filter(
      (old) => !missing.some((parent) => parent !== old && old.path.startsWith(parent.path + '/'))
    )
    const plans: Array<{ old: LocalDirectory; moved?: (typeof local)[number]; empty: boolean }> = []
    const entries: StateEntry[] = []
    for await (const entry of this.state.all()) entries.push(entry)
    for (const old of roots.sort((a, b) => a.path.length - b.path.length)) {
      this.signal?.throwIfAborted()
      // Inode equality only nominates candidates. A replacement rename and
      // inode recycling are indistinguishable without descendant evidence.
      const foreignPaths = new Set(
        doc.directories.filter((d) => d.file_id !== old.file_id).map((d) => d.path)
      )
      const candidates = local.filter(
        (l) =>
          wirePath(l.path) !== old.path &&
          (l.identity === old.identity || wasCandidate(old.path, l))
      )
      const children = entries.filter((child) => child.wirePath.startsWith(old.path + '/'))
      const empty =
        children.length === 0 &&
        !doc.directories.some((child) => child.path.startsWith(old.path + '/'))
      let moved: (typeof local)[number] | undefined
      if (candidates.length === 1 && !foreignPaths.has(wirePath(candidates[0]!.path))) {
        const candidate = candidates[0]!
        if (empty) moved = candidate
        for (const child of children) {
          const target = wirePath(candidate.path) + child.wirePath.slice(old.path.length)
          if (inventory.blocked(target)) continue
          const path = inventory.resolve(target, 'file')
          const here = await this.fs.stat(path)
          if (!here || here.size !== child.size) continue
          const found = await fingerprintFile(this.fs, path, sha256)
          const after = await this.fs.stat(path)
          if (found.sha === child.sha && after?.size === here.size && after.mtime === here.mtime) {
            moved = candidate
            break
          }
        }
      }
      // Never reinterpret an ambiguous move as recursive deletion. In
      // particular, replacement of an occupied remote identity needs resolution.
      if (candidates.length && !moved && !empty) {
        for (const path of [old.path, ...candidates.map((dir) => wirePath(dir.path))])
          doc.refused = [
            ...(doc.refused ?? []).filter(
              (row) => row.path !== path || !row.evidence || row.source !== old.path
            ),
            {
              path,
              source: old.path,
              candidateIdentity: candidates.find((dir) => wirePath(dir.path) === path)?.identity,
              code: 'conflict',
              message: 'directory move evidence is ambiguous; old and candidate subtrees are held',
              direction: 'push',
              evidence: true,
            },
          ]
        continue
      }
      if (moved)
        doc.refused = [
          ...(doc.refused ?? []),
          ...previousEvidence.filter((row) => row.source === old.path),
        ]
      plans.push({ old, moved, empty })
    }
    // Keep resolved candidate evidence durable until the replacement move journal
    // is saved: a crash between clearing the hold and saving that journal must
    // not forget a candidate whose inode has since changed.
    // Publish all subtree barriers together before emitting any directory operation.
    // A restart sees the previous complete decision or this recomputed one.
    await this.save(doc)
    const blockedTree = (path: string) =>
      this.refusalFor(path) ||
      doc.refused?.some((row) => row.evidence && row.path.startsWith(wirePath(path) + '/'))
    for (const { old, moved, empty } of plans) {
      const retained = doc.refused
      if (moved) {
        doc.refused = doc.refused?.filter((row) => !row.evidence || row.source !== old.path)
        this.indexRefusals(doc.refused ?? [])
      }
      if (blockedTree(old.path) || (moved && blockedTree(moved.path))) {
        doc.refused = retained
        this.indexRefusals(doc.refused ?? [])
        continue
      }
      // A widened/reset scope needs its snapshot before absence is a deletion.
      // The next ordinary cycle can delete missing folders on a known baseline.
      if (!moved && (await this.state.getCursor()) === 0) continue
      const op: V2CommitOp = moved
        ? {
            op: 'move_directory',
            file_id: old.file_id,
            base_version_id: old.version_id,
            to_path: wirePath(moved.path),
            ...(empty ? { empty_only: true as const } : {}),
          }
        : {
            op: 'delete_directory',
            file_id: old.file_id,
            base_version_id: old.version_id,
            ...(empty ? { empty_only: true as const } : {}),
          }
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
      this.signal?.throwIfAborted()
      if (this.refusalFor(dir.path)) continue
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

  /** A recreated directory revokes the old recursive-delete intent, never current bytes. */
  async retireRecreatedDelete(): Promise<boolean> {
    const doc = await this.read(),
      pending = doc.pending
    if (pending?.op.op !== 'delete_directory' || !this.fs.listDirectories) return false
    const fileId = pending.op.file_id
    const old = doc.directories.find((dir) => dir.file_id === fileId)
    if (!old) return false
    if (old.version_id !== pending.op.base_version_id) {
      // A later remote version is not a recreated local directory. Retire only
      // the obsolete delete request, keeping its newer identity and baseline.
      delete doc.pending
      await this.save(doc)
      return true
    }
    const inventory = await LocalPaths.forPath(this.fs, old.path, this.state)
    if (
      inventory.blocked(old.path) ||
      !inventory.directory(inventory.resolve(old.path, 'directory'))
    )
      return false
    const within = (path: string) => path === old.path || path.startsWith(old.path + '/')
    const entries: StateEntry[] = []
    for await (const entry of this.state.all()) if (within(entry.wirePath)) entries.push(entry)
    const review = JSON.parse(
      (await this.state.getMeta!('v2-directory-review')) ?? '[]'
    ) as unknown[]
    delete doc.pending
    doc.directories = doc.directories.filter((dir) => !within(dir.path))
    doc.incoming = doc.incoming?.filter((item) => !within(item.path))
    doc.removals = doc.removals.filter(
      (item) => !within(typeof item === 'string' ? item : item.path)
    )
    await transact(this.state, async (tx) => {
      await tx.setMeta!(
        'v2-directory-review',
        JSON.stringify([
          ...review,
          {
            pending,
            path: old.path,
            reason: 'directory recreated before pending deletion was reconciled',
          },
        ])
      )
      for (const entry of entries) await tx.delete(entry.path)
      await tx.setCursor(0)
      await tx.setMeta!('pull-manifest-progress', null)
      await tx.setMeta!('pull-manifest-page', null)
      await this.save(doc, tx)
    })
    return true
  }
}
