import {
  normalisePath,
  type CommitOp,
  type CommitOpResult,
  type ErrorCode,
} from '@abele/sync-protocol'
import { settledStat, writeExpected } from './apply.js'
import { EngineError } from './errors.js'
import { touchesDeferred } from './defer.js'
import type { FileSystem } from './fs.js'
import { inTheWay, sentBy, type Content, type PushDisk } from './pushDisk.js'
import type { PushReport, Refusal, ResumeOptions } from './pusher.js'
import type { Aside, Verdicts } from './pushVerdicts.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * A commit's verdicts carried onto this disk and into this state, one op at a time, inside the
 * transaction that clears the journal; and the refusals the server gave for good, remembered.
 */

/**
 * Only the per-file cap is stable without a policy change. A quota refusal can be
 * caused by other files' live usage and must be tried again when those files go.
 */
export const FINAL_REFUSALS: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['too_large'])

/** The recording half of one push: the adapters, the options and the report it fills in. */
export class VerdictRecorder {
  constructor(
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: ResumeOptions,
    private readonly report: PushReport,
    private readonly hash: (bytes: Uint8Array) => Promise<string>,
    private readonly refused: Map<string, Refusal>,
    private readonly disk: PushDisk
  ) {}

  /** Write a refusal down, once. */
  refuse(sha: string, refusal: Refusal): void {
    if (this.refused.has(sha)) return
    this.refused.set(sha, { code: refusal.code, message: refusal.message })
    this.opts.log?.(`push: the server will not take ${sha}: ${refusal.code} ${refusal.message}`)
  }

  /** One op and what the server made of it. */
  async take(
    op: CommitOp,
    result: CommitOpResult | undefined,
    at: number,
    verdicts: Verdicts
  ): Promise<void> {
    if (result === undefined) throw new EngineError('protocol', 'an op came back without a result')
    const problem = verdicts.bad.get(at)
    if (problem !== undefined) {
      // The server took the op, at a path this device will not put on a disk. The file is left
      // as the scan found it and the op reported as refused, so the engine keeps its path clear
      // of the pulls and the next scan sends it again.
      const message = `the server answered with a path this device will not take: ${problem}`
      this.report.rejected.push({ op, code: 'invalid_path', message })
      this.opts.log?.(`push: ${op.op} not recorded: ${message}`)
      return
    }
    if (result.status === 'rejected') {
      // The local file stays exactly as the scan found it — except a refused rename, which
      // goes back where it was: the entry still says the old path, and left at the new one
      // the file would be a rename every scan sends and the server refuses again, while the
      // pull holds whatever the server settled on because the old path counts as edited.
      this.report.rejected.push({ op, code: result.code, message: result.message })
      this.opts.log?.(`push: ${op.op} refused: ${result.code} ${result.message}`)
      if ('sha' in op && FINAL_REFUSALS.has(result.code)) this.refuse(op.sha, result)
      if (op.op === 'move') await this.disk.undoMove(op)
      return
    }

    const previous = await this.state.byFileId(result.file_id)
    if (result.status === 'applied' && op.op === 'delete') {
      if (previous !== null) await this.state.delete(previous.path)
      this.report.applied++
      return
    }

    const target = await this.disk.targetOf(result.path, result.file_id)
    const staged = verdicts.staged.get(at)
    if (
      staged === undefined &&
      touchesDeferred(
        this.opts.defer,
        result.path,
        previous?.wirePath,
        result.status === 'conflict' ? result.conflict_path : null
      )
    ) {
      // Matching bytes during planning are not a write permit. Deferred verdicts only adopt
      // existing bytes or stay held here; no code path below may mutate their filesystem.
      if (
        result.sha !== null &&
        (await this.disk.holds(target, result.sha)) &&
        (previous === null ||
          previous.path === target ||
          (await this.fs.stat(previous.path)) === null)
      ) {
        if (previous !== null && previous.path !== target) await this.state.delete(previous.path)
        await this.remember(target, result, result.sha, result.size, result.mtime, true)
      } else {
        await this.keepBase(op, result, previous, await this.disk.whereIs(previous, target))
      }
      this.count(result)
      return
    }
    if (staged === undefined && !(await this.disk.place(previous, target))) {
      // A folder or a link has the target's name. The file and its entry stay where they were,
      // and the path is kept clear of the pulls; the feed brings this verdict again, and the
      // puller holds it, with the same line in the log, until the disk is clear.
      this.report.kept.push(result.path)
      return
    }
    const incoming = verdicts.writes.get(at)
    const kept = verdicts.aside.get(at)
    const sent = sentBy(op, previous)
    // Planning precedes downloads (and later runs may wait much longer). Ask
    // again at the write boundary; a plan is not permission to overwrite typing.
    const changed =
      incoming !== undefined &&
      !(await this.disk.holds(target, incoming)) &&
      !(await this.disk.untouched(op, sent, target))
    if (verdicts.stale.has(at) || changed) {
      await this.keepBase(op, result, previous, target)
    } else if (staged !== undefined) {
      // No history proof is not approval. With no base, leave the local file unrecorded and
      // the head staged; never fall through to adopting or writing the server's head.
      if (staged.base !== null && sent !== null && op.op !== 'delete') {
        const localPath = await this.disk.whereIs(previous, target)
        if (previous !== null && previous.path !== localPath) await this.state.delete(previous.path)
        await this.state.put({
          path: localPath,
          wirePath: normalisePath(localPath),
          fileId: result.file_id,
          versionId: staged.base,
          sha: sent.sha,
          size: sent.size,
          mtime: sent.mtime,
        })
      }
    } else if (kept !== undefined && sent !== null) {
      await this.setAside(result, target, sent, kept)
    } else if (incoming === undefined) {
      // The server took the op as it was sent, so what is on disk is already the version it
      // named. The size and mtime recorded are the disk's own — the ones the op read off it —
      // and not the server's echo of them, so the next scan finds them and hashes nothing.
      if (sent === null) {
        throw new EngineError('protocol', `nothing on this disk to record for ${result.path}`)
      }
      await this.remember(target, result, sent.sha, sent.size, sent.mtime, false)
    } else {
      const bytes = verdicts.fetched.get(incoming)
      if (bytes !== undefined) {
        await writeExpected(this.fs, this.opts.expected, target, incoming, bytes, result.mtime)
      }
      await this.remember(target, result, incoming, result.size, result.mtime, true)
    }

    this.count(result)
  }

  private count(result: Exclude<CommitOpResult, { status: 'rejected' }>): void {
    if (result.status === 'applied') this.report.applied++
    else if (result.status === 'merged') this.report.merged++
    else this.report.conflicts++
  }

  /**
   * The local copy of a file whose head this device does not sync, recorded where `asideOf`
   * said. A conflict copy is where the vault keeps these bytes, so the file moves there and is
   * that copy; the head's path is left empty here, as for any file over the cap. When the copy's
   * path is taken on this disk, or there is nothing but the head to record against, no entry is
   * kept and the path is reported kept, as a stale create is.
   */
  private async setAside(
    result: Exclude<CommitOpResult, { status: 'rejected' }>,
    target: string,
    sent: Content,
    aside: Aside
  ): Promise<void> {
    if (aside.kind === 'drop') {
      this.opts.log?.(
        `push: ${result.path}: the vault's head outlives this delete and is more than this device syncs`
      )
      await this.state.delete(target)
      return
    }
    this.opts.log?.(
      `push: ${result.path}: the vault's head is more than this device syncs; the copy here stays`
    )
    if (aside.kind === 'version') {
      await this.state.put({
        path: target,
        wirePath: result.path,
        fileId: result.file_id,
        versionId: aside.versionId,
        sha: sent.sha,
        size: sent.size,
        mtime: sent.mtime,
      })
      return
    }
    await this.state.delete(target)
    if (aside.kind === 'copy' && result.status === 'conflict') {
      const copy = await this.disk.targetOf(result.conflict_path, result.conflict_file_id)
      if ((await this.fs.stat(copy)) === null) {
        try {
          await this.fs.move(target, copy)
          await this.state.put({
            path: copy,
            wirePath: result.conflict_path,
            fileId: result.conflict_file_id,
            versionId: result.conflict_version_id,
            sha: sent.sha,
            size: sent.size,
            mtime: sent.mtime,
          })
          return
        } catch (error) {
          if (!inTheWay(error)) throw error
        }
      }
    }
    this.opts.log?.(`push: ${target} is left unrecorded: nothing but the head to record it against`)
    this.report.kept.push(result.path)
  }

  /**
   * Somebody typed into the file while this batch was in the air, so the server's bytes are
   * not written over theirs — and neither side is lost.
   *
   * The entry is left on the base the op was sent against, holding what the op sent, so the
   * next scan sees the newer bytes as a modify *of that same base* and pushes it. The server
   * then has the base, its own head and the newer text, and merges all three: the merge this
   * result was is not thrown away, it is merged into again. Advancing the entry to the new
   * version would have been the thing that lost the other device's edit — the next push would
   * have been a clean modify of the head, and the head is exactly what it must not overwrite.
   *
   * A create has no base to keep. Leaving no entry at all is what makes the next scan a create
   * again, which the server resolves from an empty base against whatever is at that path — so
   * both sides are kept there too. The same goes for a file this device has no record of.
   */
  private async keepBase(
    op: CommitOp,
    result: Exclude<CommitOpResult, { status: 'rejected' }>,
    previous: StateEntry | null,
    target: string
  ): Promise<void> {
    this.opts.log?.(
      `push: ${target} changed since the scan; its ${result.status} is recorded, not written`
    )
    this.report.kept.push(result.path)
    const sent = sentBy(op, previous)
    if (op.op === 'create' || sent === null) {
      await this.state.delete(target)
      return
    }
    // A create and a restore name no base; both are gone by here, and everything else has one.
    const version = 'base_version_id' in op ? op.base_version_id : result.version_id
    const have = await this.fs.stat(target)
    // A content hold can occur with unchanged/rounded metadata. Persist a
    // mismatching scan hint so restart cannot mistake the known unsent edit for
    // unchanged bytes. This is not timestamp/authorship or replacement proof.
    const mtime =
      have !== null && have.size === sent.size && have.mtime === sent.mtime
        ? sent.mtime === 0
          ? 1
          : sent.mtime - 1
        : sent.mtime
    await this.state.put({
      path: target,
      wirePath: result.path,
      fileId: result.file_id,
      versionId: version,
      sha: sent.sha,
      size: sent.size,
      mtime,
    })
  }

  /**
   * Write down what is now at `target`. `fromDisk` takes the size and mtime from the file
   * itself: after a write they are the result's own, and after a write that was not needed
   * they are what the file already had — either way the next scan compares them against a
   * `stat` and finds them. An edit that lands between the write and that `stat` is not
   * filed under the server's sha: `settledStat` records what was written instead.
   */
  private async remember(
    target: string,
    result: Exclude<CommitOpResult, { status: 'rejected' }>,
    sha: string,
    size: number,
    mtime: number,
    fromDisk: boolean
  ): Promise<void> {
    const have = fromDisk
      ? await settledStat(this.fs, target, sha, { size, mtime }, this.hash)
      : { size, mtime }
    await this.state.put({
      path: target,
      wirePath: result.path,
      fileId: result.file_id,
      versionId: result.version_id,
      sha,
      size: have.size,
      mtime: have.mtime,
    })
  }
}
