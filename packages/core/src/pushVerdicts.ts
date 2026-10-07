import { normalisePath, type CommitOp, type CommitOpResult } from '@abele/sync-protocol'
import {
  bytesFor,
  DEFAULT_PREFETCH_BYTES,
  pool,
  resultProblem,
  runsWithin,
  shaIndex,
} from './apply.js'
import type { VaultClient } from './client.js'
import { touchesDeferred, type Staged } from './defer.js'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import { sentBy, type Content, type PushDisk } from './pushDisk.js'
import type { ResumeOptions } from './pusher.js'
import { stagedHead } from './pushStage.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * What a commit's results call for, worked out before the state is touched: the bytes to fetch,
 * the writes, the verdicts left on their base, and the heads set aside or staged.
 */

/** What one commit's results need before the state is touched: bytes, and what to do with them. */
export interface Verdicts {
  /**
   * sha → bytes, for the writes of the run being recorded that need some this disk does not
   * already have. Filled a run at a time (`fetchRun`) and emptied before the next, so what it
   * holds is at most `prefetchBytes`, or the one head of a run bigger than that.
   */
  fetched: Map<string, Uint8Array>
  /**
   * Every result index, in order, cut into runs whose downloads fit `prefetchBytes`. The first
   * run's bytes are fetched by `plan`, before the state is touched; each later run's just
   * before it is recorded.
   */
  runs: number[][]
  /** The shas some write has to bring in, from a local file or the server. */
  wanted: Set<string>
  /** One synced file per sha, as the state stood when the plan was made. */
  local: Map<string, StateEntry>
  /** The results whose target changed since the scan; nothing of theirs is written. */
  stale: Set<number>
  /** Result index → what is wrong with the paths it names; nothing of theirs touches the disk. */
  bad: Map<number, string>
  /** Result index → the sha to put at its target. Absent where the file is already right. */
  writes: Map<number, string>
  /**
   * Result index → where the local file goes, for a head this device does not sync: recorded
   * against a version that is not the head, moved to the conflict copy that holds its bytes, or
   * left with no entry when the vault has neither.
   */
  aside: Map<number, Aside>
  /** Result index → the head staged in place of a write, at a path the host stages. */
  staged: Map<number, Staged>
}

/**
 * A verdict whose head is over this device's cap. The disk keeps what it sent and never the
 * head, so the entry must never name the head.
 */
export type Aside =
  { kind: 'version'; versionId: string } | { kind: 'copy' } | { kind: 'none' } | { kind: 'drop' }

/** A result the server did not refuse. */
type Answered = Exclude<CommitOpResult, { status: 'rejected' }>

/** How many versions one history request asks for while looking for the bytes sent. */
const VERSION_PAGE = 100

/** The planning half of one push: the adapters and the options it runs over. */
export class VerdictPlanner {
  constructor(
    private readonly client: VaultClient,
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: ResumeOptions,
    private readonly hash: (bytes: Uint8Array) => Promise<string>,
    private readonly concurrency: number,
    private readonly disk: PushDisk
  ) {}

  /**
   * What the results call for, worked out before the state is touched: what follows writes
   * files and rows, and should not be holding a transaction open on a download.
   *
   * Every verdict that would change the bytes at a path goes through the same two questions,
   * whatever it is called. Does the file already hold those bytes? Then there is nothing to
   * fetch and nothing to write, only a row to bring up to date — and that is asked first,
   * because a replay of a batch whose files were written before the crash finds every one of
   * them right, and with a size and mtime the op never sent. Otherwise, is the file still
   * what the op said it was? If not it is somebody's unpushed typing and nothing is written
   * over it — and nothing is downloaded for it either, which would be bytes fetched to be
   * thrown away.
   *
   * An `applied` result changes the bytes when the version it names is not the one the op
   * sent: a move carried across a head another device had edited. Every other `applied` is
   * the op's own bytes, already lying where they belong.
   *
   * Only the first run's bytes are fetched here (`Verdicts.runs`); a batch whose heads do not
   * fit `prefetchBytes` fetches the rest a run at a time as it records them, inside the
   * transaction — holding that open on a download is the price of never holding the whole
   * batch's bytes at once, and a batch of notes never pays it.
   */
  async plan(ops: CommitOp[], results: CommitOpResult[]): Promise<Verdicts> {
    const stale = new Set<number>()
    const writes = new Map<number, string>()
    const bad = new Map<number, string>()
    const aside = new Map<number, Aside>()
    const staged = new Map<number, Staged>()
    const wanted = new Set<string>()
    /** Answers at a staged path, whose history is looked through once the loop is done. */
    const lookups: Array<{
      at: number
      result: Answered
      sentSha: string | null
      base: string | null
      local: { path: string; sha: string | null }
    }> = []
    for (const [at, result] of results.entries()) {
      if (result.status === 'rejected') continue
      const op = ops[at]
      if (op === undefined) continue
      // A path the wire would never carry names nothing on this disk. Nothing is fetched for
      // it and nothing recorded under it; `take` reports it as the server's refusal in reverse.
      const problem = resultProblem(result)
      if (problem !== null) {
        bad.set(at, problem)
        continue
      }
      // The scanner never emits one, so no journal can hold one either.
      if (op.op === 'restore')
        throw new EngineError('protocol', 'the pusher does not send restores')
      // A delete the server took leaves nothing on disk to protect and nothing to write.
      if (result.status === 'applied' && op.op === 'delete') continue

      const previous = await this.state.byFileId(result.file_id)
      const sent = sentBy(op, previous)
      const incoming = this.incomingSha(op, result, sent)
      const target = await this.disk.targetOf(result.path, result.file_id)
      const file = await this.disk.whereIs(previous, target)
      const moves =
        previous !== null &&
        previous.path !== target &&
        (await this.fs.stat(previous.path)) !== null
      const touches = touchesDeferred(
        this.opts.defer,
        result.path,
        previous?.wirePath,
        op.op === 'create' ? op.path : op.op === 'move' ? op.to_path : null,
        result.status === 'conflict' ? result.conflict_path : null
      )
      // A matching SHA at the source is not consent to install it at another path. Test the
      // final placement, including both ends of a move, before the accepted-unchanged shortcut.
      if (
        touches &&
        (moves || result.sha === null || !(await this.disk.holds(target, result.sha)))
      ) {
        lookups.push({
          at,
          result,
          sentSha: sent?.sha ?? null,
          base: previous?.versionId ?? null,
          local: { path: file, sha: op.op === 'delete' ? null : (sent?.sha ?? null) },
        })
        continue
      }
      if (incoming === null) continue
      if (await this.disk.holds(file, incoming)) {
        writes.set(at, incoming)
        continue
      }
      if (!(await this.disk.untouched(op, sent, file))) {
        stale.add(at)
        continue
      }
      if (sent !== null && this.opts.filter?.excluded(result.path, result.size)) {
        aside.set(at, await this.asideOf(op, result, sent.sha, previous))
        continue
      }
      writes.set(at, incoming)
      wanted.add(incoming)
    }
    // Each history paged through `concurrency` at a time rather than one after another
    //, then taken in the results' order, so what is staged and said is the same.
    const heads = new Map<number, Staged | null>()
    await pool(lookups, this.concurrency, async ({ at, result, sentSha, base, local }) => {
      const head = await stagedHead(this.client, result, sentSha, base, normalisePath(local.path))
      heads.set(
        at,
        head === null
          ? null
          : {
              ...head,
              ...(local.sha === null ? { base } : {}),
              settled: local,
            }
      )
    })
    for (const { at, result } of lookups) {
      const head = heads.get(at) ?? null
      if (head !== null) {
        staged.set(at, head)
        continue
      }
      this.opts.log?.(`push: ${result.path}: the server head cannot be staged; held, not written`)
      stale.add(at)
    }

    // A merged head can be as large as any file, and a batch holds up to a thousand of them:
    // their bytes come in runs that fit the budget, as the pull's do, and only the first run
    // is fetched before the state is touched.
    const budget = this.opts.prefetchBytes ?? DEFAULT_PREFETCH_BYTES
    const downloads = (at: number): number => {
      const sha = writes.get(at)
      const result = results[at]
      if (sha === undefined || !wanted.has(sha) || result === undefined) return 0
      return result.status === 'rejected' ? 0 : result.size
    }
    const runs = runsWithin([...results.keys()], downloads, budget)
    const verdicts: Verdicts = {
      fetched: new Map(),
      runs,
      wanted,
      local: await shaIndex(this.state),
      stale,
      writes,
      bad,
      aside,
      staged,
    }
    await this.fetchRun(runs[0] ?? [], verdicts)
    return verdicts
  }

  /**
   * The bytes one run of results will write, in place of the last run's, which are let go.
   * A verdict whose bytes the server could not produce is kept on its base like a stale one:
   * the file stays as the scan found it, and the next scan sends it again.
   */
  async fetchRun(run: number[], verdicts: Verdicts): Promise<void> {
    const { fetched, writes, wanted, stale, local } = verdicts
    fetched.clear()
    const shas = new Set<string>()
    for (const at of run) {
      const sha = writes.get(at)
      if (sha !== undefined && wanted.has(sha)) shas.add(sha)
    }
    await pool([...shas], this.concurrency, async (sha) => {
      const bytes = await bytesFor(this.client, this.fs, sha, local, this.hash)
      if (bytes !== null) fetched.set(sha, bytes)
      else this.opts.log?.(`push: the server's bytes for ${sha} do not hash to it; not written`)
    })
    for (const at of run) {
      const sha = writes.get(at)
      if (sha !== undefined && shas.has(sha) && !fetched.has(sha)) {
        stale.add(at)
        writes.delete(at)
      }
    }
  }

  /**
   * Where the local copy is recorded when the head is more than this device syncs. The entry
   * never names the head, which the disk does not hold, and always names a version the disk's
   * bytes really derive from: recorded against anything else, the next edit here would read,
   * to the server's merge, as deleting whatever that version holds and the disk does not.
   *
   * - A delete that lost: nothing is on disk, and the head is not synced here, so the entry
   *   goes and nothing is recorded. Kept, it would be a delete every scan sends again.
   * - A conflict copied the bytes sent to a file of their own, so the local file becomes that
   *   copy.
   * - Otherwise the version that holds exactly the bytes sent, the whole history paged
   *   through. The server keeps what it merged in as a version of its own, so there is one:
   *   the next edit is then merged from the text the disk holds, and only that edit moves.
   * - Where no version holds them (a server that did not keep them), an edit is recorded
   *   against the version it was sent against, which the disk derives from: the next edit is
   *   merged from that base again, and the head's other lines stay, the first edit at worst
   *   twice. A move sent the entry's own bytes, so it keeps the entry's version: one retention
   *   pruned is unknown to the server, whose merge then runs from an empty base and duplicates
   *   text rather than delete it. A create derives from nothing on the server and keeps no
   *   entry, which only an old server makes it send again each run.
   */
  private async asideOf(
    op: CommitOp,
    result: Exclude<CommitOpResult, { status: 'rejected' }>,
    sha: string,
    previous: StateEntry | null
  ): Promise<Aside> {
    if (op.op === 'delete') return { kind: 'drop' }
    if (result.status === 'conflict') return { kind: 'copy' }
    let before: number | undefined
    for (;;) {
      const page = await this.client.versions(result.file_id, {
        limit: VERSION_PAGE,
        ...(before === undefined ? {} : { before }),
      })
      for (const version of page) {
        if (version.version_id === result.version_id) continue
        if (version.sha === sha) return { kind: 'version', versionId: version.version_id }
      }
      const last = page.at(-1)
      if (page.length < VERSION_PAGE || last === undefined) break
      before = last.no
    }
    if (op.op === 'modify') return { kind: 'version', versionId: op.base_version_id }
    if (op.op === 'move' && previous !== null) {
      return { kind: 'version', versionId: previous.versionId }
    }
    return { kind: 'none' }
  }

  /** The sha a verdict would have to put at the target, or null when the file is already it. */
  private incomingSha(
    op: CommitOp,
    result: Exclude<CommitOpResult, { status: 'rejected' }>,
    sent: Content | null
  ): string | null {
    if (result.status !== 'applied') return result.sha
    // A non-delete always leaves bytes behind; a server that says otherwise is not one this
    // client understands, and falling back on what was sent would file the wrong sha.
    if (result.sha === null) {
      throw new EngineError('protocol', `the server applied ${op.op} of ${result.path} with no sha`)
    }
    return sent !== null && sent.sha === result.sha ? null : result.sha
  }
}
