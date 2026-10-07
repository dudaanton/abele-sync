import { createHash, randomUUID } from 'node:crypto'
import type {
  ChangeItem,
  ChangesResponse,
  CommitOp,
  CommitOpResult,
  CommitResponse,
  ErrorCode,
  ManifestResponse,
} from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { expect } from 'vitest'
import { api } from '../helpers/client.js'
import { octet } from '../helpers/ops.js'

/**
 * A simulated device: a disk, what it last synced, and a `sync()` that talks to
 * the server exactly as the client engine will. Nothing here reaches into the
 * server; every byte moves over the HTTP API.
 */

/** A file as the device has it. */
export interface DiskFile {
  content: Buffer
  mtime: number
}

/** A file as the device last saw it on the server: the base every local edit is measured from. */
export interface SyncedFile {
  fileId: string
  versionId: string
  sha: string
  mtime: number
}

export interface SimStats {
  blobPuts: number
  blobHeads: number
  blobGets: number
  commits: number
}

/**
 * What the pull needs of a change: the manifest hands out the same fields under
 * the name of a create, so a bootstrap and a feed page go through one path.
 */
type Snapshot = Pick<ChangeItem, 'file_id' | 'op' | 'path' | 'sha' | 'mtime' | 'version_id'>

/** The largest pages the feed and the manifest hand out. */
const CHANGES_PAGE = 1000
const MANIFEST_PAGE = 1000

/** One clock for every sim, so "newer" between two devices is never a tie. */
let clock = 1_700_000_000_000
export const nextMtime = (): number => ++clock

const shas = new WeakMap<Buffer, string>()

/** The sha of some bytes, hashed once per buffer: the disk is scanned by sha on every pull. */
export function shaOf(content: Buffer): string {
  let sha = shas.get(content)
  if (sha === undefined) {
    sha = createHash('sha256').update(content).digest('hex')
    shas.set(content, sha)
  }
  return sha
}

export class SimDevice {
  readonly disk = new Map<string, DiskFile>()
  readonly state = new Map<string, SyncedFile>()
  cursor = 0
  readonly stats: SimStats = { blobPuts: 0, blobHeads: 0, blobGets: 0, commits: 0 }
  readonly rejected: Array<{ op: CommitOp; code: ErrorCode }> = []
  /** Where each synced file is, by id: the index `state` is read through. */
  private readonly paths = new Map<string, string>()
  /**
   * Remote changes held back, by file id: the file they name, or the path they
   * land on, has a local edit pending. The pull never overwrites an edit; the
   * push tells the server about it and the result says who won. A held change
   * is retried on the next pull once its file and path are clean again, and
   * dropped when a result for its file arrives.
   */
  private readonly held = new Map<string, Snapshot>()
  private readonly http: ReturnType<typeof api>

  constructor(
    app: FastifyInstance,
    private readonly vaultId: string,
    deviceToken: string,
    readonly name: string
  ) {
    this.http = api(app, deviceToken)
  }

  /* ── Local edits ─────────────────────────────────────────────────────── */

  write(path: string, text: string | Buffer, mtime = nextMtime()): void {
    this.disk.set(path, { content: Buffer.from(text), mtime })
  }

  rm(path: string): void {
    this.disk.delete(path)
  }

  mv(from: string, to: string): void {
    const file = this.disk.get(from)
    if (file === undefined) throw new Error(`${this.name} has nothing at ${from}`)
    this.disk.delete(from)
    this.disk.set(to, file)
  }

  text(path: string): string | undefined {
    return this.disk.get(path)?.content.toString('utf8')
  }

  /* ── Sync ────────────────────────────────────────────────────────────── */

  /** Pull, then push what changed locally, then take in what the server made of it. */
  async sync(): Promise<CommitResponse | null> {
    await this.pull()
    const ops = this.localOps()
    if (ops.length === 0) return null
    await this.uploadMissing(ops)
    const response = await this.commit(ops)
    await this.applyResults(ops, response.results)
    return response
  }

  /* ── Pull ────────────────────────────────────────────────────────────── */

  private async pull(): Promise<void> {
    if (this.cursor === 0) await this.bootstrap()
    await this.retryHeld()
    for (;;) {
      const page = await this.get<ChangesResponse>(
        `changes?since=${this.cursor}&limit=${CHANGES_PAGE}`
      )
      for (const item of page.items) await this.take(item)
      this.cursor = page.next_since
      if (page.items.length === 0 || page.next_since >= page.head_seq) return
    }
  }

  /**
   * A device that has never synced walks the live files instead of the whole
   * history, then follows the feed from the head the first page reported:
   * anything committed meanwhile comes through the feed and lands on top.
   */
  private async bootstrap(): Promise<void> {
    let cursor: string | null = null
    let headSeq: number | null = null
    do {
      const after: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      const page = await this.get<ManifestResponse>(`manifest?limit=${MANIFEST_PAGE}${after}`)
      headSeq ??= page.head_seq
      for (const item of page.items) await this.take({ ...item, op: 'create' })
      cursor = page.next
    } while (cursor !== null)
    this.cursor = headSeq ?? 0
  }

  private async retryHeld(): Promise<void> {
    for (const [fileId, change] of [...this.held]) {
      if (this.dirty(change)) continue
      this.held.delete(fileId)
      await this.applyChange(change)
    }
  }

  private async take(change: Snapshot): Promise<void> {
    if (this.dirty(change)) {
      this.held.set(change.file_id, change)
      return
    }
    this.held.delete(change.file_id)
    await this.applyChange(change)
  }

  /**
   * Whether applying the change would write over a local edit: the file it
   * names has one pending — content, deletion or rename since the last sync —
   * or the path it lands on holds an unsynced local file of its own, under
   * another id or none. An edit that is exactly what arrived needs no settling.
   */
  private dirty(change: Snapshot): boolean {
    const local = this.paths.get(change.file_id)
    if (local !== undefined && this.edited(local, change.sha)) return true
    return change.sha !== null && change.path !== local && this.edited(change.path, change.sha)
  }

  /** Whether the local file at `path` differs from what was last synced there, and from `sha`. */
  private edited(path: string, sha: string | null): boolean {
    const have = this.diskSha(path) ?? null
    const synced = this.state.get(path)?.sha ?? null
    return have !== synced && have !== sha
  }

  /**
   * Make the local file what the change says it is: gone, or at its path with
   * its bytes. The bytes come from the file itself when only the path changed,
   * from any other local file with the same sha, and from the server otherwise.
   */
  private async applyChange(change: Snapshot): Promise<void> {
    const local = this.paths.get(change.file_id)
    if (change.op === 'delete' || change.sha === null) {
      if (local !== undefined) {
        this.disk.delete(local)
        this.forget(local)
      }
      return
    }
    const content = await this.bytesFor(change.sha, local)
    if (local !== undefined && local !== change.path) {
      this.disk.delete(local)
      this.forget(local)
    }
    const mtime = change.mtime ?? 0
    this.disk.set(change.path, { content, mtime })
    this.remember(change.path, {
      fileId: change.file_id,
      versionId: change.version_id,
      sha: change.sha,
      mtime,
    })
  }

  private async bytesFor(sha: string, local: string | undefined): Promise<Buffer> {
    const here = local === undefined ? undefined : this.disk.get(local)
    if (here !== undefined && shaOf(here.content) === sha) return here.content
    return this.findLocal(sha) ?? this.fetch(sha)
  }

  /* ── Push ────────────────────────────────────────────────────────────── */

  /**
   * The disk against the state: a path the state lacks is a create, a path the
   * disk lacks is a delete, the same path with other bytes is a modify — except
   * that a missing path and a new path are one rename when they hold the same
   * bytes and there is exactly one of each, or when they are the only missing
   * and the only new path left: a rename with an edit on top, sent as a move
   * and a modify so the file keeps its history. Deletes and moves go first so
   * the paths they free are free for the creates behind them.
   */
  private localOps(): CommitOp[] {
    const missing = [...this.state].filter(([path]) => !this.disk.has(path))
    const fresh = [...this.disk].filter(([path]) => !this.state.has(path))

    const moves = new Map<string, string>()
    for (const [to, file] of fresh) {
      const sha = shaOf(file.content)
      const sources = missing.filter(([, entry]) => entry.sha === sha)
      const targets = fresh.filter(([, other]) => shaOf(other.content) === sha)
      const source = sources[0]
      if (source !== undefined && sources.length === 1 && targets.length === 1) {
        moves.set(source[0], to)
      }
    }
    const movedTo = new Set(moves.values())
    const leftMissing = missing.filter(([path]) => !moves.has(path))
    const leftFresh = fresh.filter(([path]) => !movedTo.has(path))
    const [lastMissing] = leftMissing
    const [lastFresh] = leftFresh
    if (leftMissing.length === 1 && leftFresh.length === 1 && lastMissing && lastFresh) {
      moves.set(lastMissing[0], lastFresh[0])
      movedTo.add(lastFresh[0])
    }

    const ops: CommitOp[] = []
    for (const [path, entry] of missing) {
      if (moves.has(path)) continue
      ops.push({ op: 'delete', file_id: entry.fileId, base_version_id: entry.versionId })
    }
    for (const [from, to] of moves) {
      const entry = this.synced(from)
      ops.push({
        op: 'move',
        file_id: entry.fileId,
        base_version_id: entry.versionId,
        to_path: to,
      })
    }
    for (const [path, file] of fresh) {
      if (movedTo.has(path)) continue
      ops.push({ op: 'create', path, ...bytesOf(file) })
    }
    // A file at its synced path with other bytes, or one that moved and was edited on the way.
    for (const [path, file] of this.disk) {
      const entry = this.state.get(path) ?? this.movedFrom(moves, path)
      if (entry === undefined || shaOf(file.content) === entry.sha) continue
      ops.push({
        op: 'modify',
        file_id: entry.fileId,
        base_version_id: entry.versionId,
        ...bytesOf(file),
      })
    }
    return ops
  }

  /** The synced entry a rename target came from, if it is one. */
  private movedFrom(moves: Map<string, string>, to: string): SyncedFile | undefined {
    for (const [from, target] of moves) if (target === to) return this.state.get(from)
    return undefined
  }

  /**
   * Ask after every sha the batch names and upload the ones the vault lacks. A
   * 404 says only that no version of this vault names the sha: the bytes may
   * well be in the store already, from another vault or from an upload no
   * commit followed, and the PUT is 201 either way.
   */
  private async uploadMissing(ops: CommitOp[]): Promise<void> {
    const wanted = new Set(ops.flatMap((op) => ('sha' in op ? [op.sha] : [])))
    for (const sha of wanted) {
      this.stats.blobHeads++
      const head = await this.http.raw({ method: 'HEAD', url: `/v1/blobs/${sha}` })
      if (head.status === 204) continue
      if (head.status !== 404) throw this.unexpected('HEAD blob', head)
      const content = this.findLocal(sha)
      if (content === undefined) throw new Error(`${this.name} has no file with sha ${sha}`)
      this.stats.blobPuts++
      const put = await this.http.raw({
        method: 'PUT',
        url: `/v1/blobs/${sha}`,
        payload: content,
        headers: octet,
      })
      if (put.status !== 201) throw this.unexpected('PUT blob', put)
    }
  }

  /** One batch under one fresh key: a retry of this very request would be answered, not re-run. */
  private async commit(ops: CommitOp[]): Promise<CommitResponse> {
    this.stats.commits++
    const res = await this.http.post(
      `/v1/vaults/${this.vaultId}/commit`,
      { ops },
      { 'idempotency-key': randomUUID() }
    )
    if (res.status !== 200) throw this.unexpected('commit', res)
    return res.body as CommitResponse
  }

  /* ── Results ─────────────────────────────────────────────────────────── */

  /**
   * One result per op, in order. `applied` moves the state to what was sent;
   * `merged` brings the server's bytes down over the local ones; `conflict`
   * puts the head back at the path — the local text is safe in the copy the
   * server made, which the next pull delivers; `rejected` keeps the local
   * file, and a refused rename goes back where it was so the feed can put it
   * where the winner did.
   */
  private async applyResults(ops: CommitOp[], results: CommitOpResult[]): Promise<void> {
    for (const [i, op] of ops.entries()) {
      const result = results[i]
      if (result === undefined) throw new Error(`${this.name}: op ${i} got no result`)
      if (result.status === 'rejected') {
        this.rejected.push({ op, code: result.code })
        this.undoMove(op)
        continue
      }
      const head = this.held.get(result.file_id)
      this.held.delete(result.file_id)
      if (result.status === 'applied') this.recordApplied(op, result)
      else if (result.status === 'merged') await this.takeMerged(op, result)
      else await this.takeHead(result, head)
    }
  }

  /**
   * Where the file a result is about sits before the result moves it: in the
   * state, by id — a create's result may name a file the state knows elsewhere,
   * when the path it took belonged to a file whose move was held — and on the
   * disk, where the op left it.
   */
  private placeOf(
    op: CommitOp,
    result: Exclude<CommitOpResult, { status: 'rejected' }>
  ): { stateAt: string | undefined; diskAt: string | undefined } {
    const stateAt = this.paths.get(result.file_id)
    const diskAt = op.op === 'create' ? op.path : op.op === 'move' ? op.to_path : stateAt
    return { stateAt, diskAt }
  }

  /** Drop the file's old place once the server has put it at `path`. */
  private settle(stateAt: string | undefined, diskAt: string | undefined, path: string): void {
    if (stateAt === undefined || stateAt === path) return
    this.forget(stateAt)
    if (stateAt !== diskAt) this.disk.delete(stateAt)
  }

  private recordApplied(op: CommitOp, result: Extract<CommitOpResult, { status: 'applied' }>) {
    const { stateAt, diskAt } = this.placeOf(op, result)
    if (op.op === 'delete') {
      if (stateAt !== undefined) this.forget(stateAt)
      return
    }
    if (op.op === 'restore') throw new Error(`${this.name} never restores`)
    const previous = stateAt === undefined ? undefined : this.state.get(stateAt)
    this.settle(stateAt, diskAt, result.path)
    // The server may land a file elsewhere: a modify over a head that moved meanwhile.
    if (diskAt !== undefined && diskAt !== result.path) this.rename(diskAt, result.path)
    // A move carries the bytes the state had; the feed says if the head's were other.
    const { sha, mtime } =
      op.op === 'move' ? must(previous, `${this.name} moved a file it never synced`) : op
    this.remember(result.path, {
      fileId: result.file_id,
      versionId: result.version_id,
      sha,
      mtime,
    })
  }

  private async takeMerged(
    op: CommitOp,
    result: Extract<CommitOpResult, { status: 'merged' }>
  ): Promise<void> {
    const { stateAt, diskAt } = this.placeOf(op, result)
    this.settle(stateAt, diskAt, result.path)
    if (diskAt !== undefined && diskAt !== result.path) this.disk.delete(diskAt)
    const content = this.findLocal(result.sha) ?? (await this.fetch(result.sha))
    this.disk.set(result.path, { content, mtime: result.mtime })
    this.remember(result.path, {
      fileId: result.file_id,
      versionId: result.version_id,
      sha: result.sha,
      mtime: result.mtime,
    })
  }

  /**
   * The head goes back at the path. Usually the pull held it, and the held
   * change says what it is; when the head landed between the pull and the push
   * nothing is held, and the result carries the head instead.
   */
  private async takeHead(
    result: Extract<CommitOpResult, { status: 'conflict' }>,
    head: Snapshot | undefined
  ): Promise<void> {
    await this.applyChange(
      head ?? {
        file_id: result.file_id,
        op: 'modify',
        path: result.path,
        sha: result.sha,
        mtime: result.mtime,
        version_id: result.version_id,
      }
    )
  }

  private undoMove(op: CommitOp): void {
    if (op.op !== 'move') return
    const from = this.paths.get(op.file_id)
    if (from !== undefined && this.disk.has(op.to_path)) this.rename(op.to_path, from)
  }

  /* ── State and its index ─────────────────────────────────────────────── */

  private remember(path: string, entry: SyncedFile): void {
    const before = this.state.get(path)
    if (before !== undefined && before.fileId !== entry.fileId) this.paths.delete(before.fileId)
    this.state.set(path, entry)
    this.paths.set(entry.fileId, path)
  }

  private forget(path: string): void {
    const entry = this.state.get(path)
    if (entry === undefined) return
    this.state.delete(path)
    if (this.paths.get(entry.fileId) === path) this.paths.delete(entry.fileId)
  }

  private synced(path: string): SyncedFile {
    return must(this.state.get(path), `${this.name} never synced ${path}`)
  }

  /* ── Small helpers ───────────────────────────────────────────────────── */

  private async get<T>(what: string): Promise<T> {
    const res = await this.http.get(`/v1/vaults/${this.vaultId}/${what}`)
    if (res.status !== 200) throw this.unexpected(`GET ${what}`, res)
    return res.body as T
  }

  private async fetch(sha: string): Promise<Buffer> {
    this.stats.blobGets++
    const res = await this.http.get(`/v1/blobs/${sha}`)
    if (res.status !== 200) throw this.unexpected('GET blob', res)
    if (shaOf(res.buffer) !== sha)
      throw new Error(`${this.name}: blob ${sha} came back as other bytes`)
    return res.buffer
  }

  private diskSha(path: string): string | undefined {
    const file = this.disk.get(path)
    return file === undefined ? undefined : shaOf(file.content)
  }

  private findLocal(sha: string): Buffer | undefined {
    for (const file of this.disk.values()) if (shaOf(file.content) === sha) return file.content
    return undefined
  }

  private rename(from: string, to: string): void {
    const file = this.disk.get(from)
    if (file === undefined) return
    this.disk.delete(from)
    this.disk.set(to, file)
  }

  private unexpected(what: string, res: { status: number; raw: string }): Error {
    return new Error(`${this.name}: ${what} answered ${res.status}: ${res.raw}`)
  }
}

const bytesOf = (file: DiskFile): { sha: string; size: number; mtime: number } => ({
  sha: shaOf(file.content),
  size: file.content.length,
  mtime: file.mtime,
})

function must<T>(value: T | undefined, why: string): T {
  if (value === undefined) throw new Error(why)
  return value
}

/** Every path with its bytes, in path order, as latin1 so the diff of a mismatch reads. */
const listing = (device: SimDevice): Record<string, string> =>
  Object.fromEntries(
    [...device.disk]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, f]) => [path, f.content.toString('latin1')])
  )

/** Sync each device twice in order, then assert every disk is byte-equal to the first. */
export async function converge(...devices: SimDevice[]): Promise<void> {
  for (let round = 0; round < 2; round++) for (const device of devices) await device.sync()
  const [first, ...rest] = devices
  if (first === undefined) return
  for (const device of rest) {
    expect(listing(device), `${device.name} differs from ${first.name}`).toEqual(listing(first))
  }
}
