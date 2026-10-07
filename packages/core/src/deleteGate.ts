import type { CommitOp } from '@abele/sync-protocol'
import {
  DEFAULT_DELETE_GUARD,
  DEFAULT_DELETE_WINDOW_MS,
  judgeDeletes,
  type DeleteDecision,
  type DeleteGuard,
  type DeleteHolds,
} from './deletes.js'
import type { FileSystem } from './fs.js'
import type { ScanFilter } from './scanner.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * The delete guard as one sync runs it (see `deletes.ts`): which of a scan's deletes go and
 * which are held, what a commit's deletes count toward the window, and what a host's `restore`
 * decision and the server's own deletes take out of the hold.
 */

/** The engine, as the delete guard needs it. */
export interface DeleteGateContext {
  state: StateStore
  fs: FileSystem
  filter: ScanFilter
  holds: DeleteHolds
  deleteGuard: DeleteGuard | false | undefined
  now: () => number
  log: (line: string) => void
  /** How many deletes the hold keeps now, onto the status. */
  onHeld: (count: number) => void
  /** The next run walks the vault again from the start. */
  rewind: () => void
}

export class DeleteGate {
  constructor(private readonly ctx: DeleteGateContext) {}

  /**
   * The scan's ops as the delete guard lets them go: everything, or everything but the deletes
   * it holds, which are filed for a host to list and said once in the log each time they change.
   */
  async judge(ops: CommitOp[], confirmed: ReadonlySet<string>): Promise<CommitOp[]> {
    const entries: StateEntry[] = []
    for await (const entry of this.ctx.state.all()) entries.push(entry)
    const guard = this.ctx.deleteGuard ?? DEFAULT_DELETE_GUARD
    const before = new Set((await this.ctx.holds.list()).map((one) => one.fileId))
    const recent = await this.ctx.holds.recent(this.ctx.now(), this.deleteWindow())
    const { send, held, inScope } = judgeDeletes(ops, entries, this.ctx.filter, confirmed, guard, {
      sticky: before,
      recent,
    })
    // A held file back on the disk leaves the hold with no decision. If a walk passed over a
    // change to one, the next run walks the vault again so that change arrives.
    const now = new Set(held.map((one) => one.fileId))
    const left = [...before].some((id) => !now.has(id) && !confirmed.has(id))
    if (left && (await this.ctx.holds.noted())) {
      await this.ctx.holds.setNoted(false)
      this.ctx.rewind()
    }
    if ((await this.ctx.holds.record(held)) && held.length > 0) {
      const share = inScope === 0 ? 100 : Math.round((held.length / inScope) * 100)
      // The recent ones count toward the trip, so a hold of a few says they are what tripped it.
      const minutes = Math.round(this.deleteWindow() / 60_000)
      const more = recent > 0 ? `; ${recent} more went out in the last ${minutes} minutes` : ''
      this.ctx.log(
        `push: held ${held.length} deletions (${share}% of the vault)${more}; ` +
          'confirm or put them back'
      )
    }
    // Nothing held, nothing a walk passed over can be waiting on it.
    if (held.length === 0) await this.ctx.holds.setNoted(false)
    this.ctx.onHeld(held.length)
    return send
  }

  /**
   * Held deletes the server's own delete settled (`PullReport.settled`): out of the hold with no
   * decision, since there is nothing left to decide about them.
   */
  async release(fileIds: readonly string[]): Promise<void> {
    const settled = new Set(fileIds)
    const rest = (await this.ctx.holds.list()).filter((one) => !settled.has(one.fileId))
    await this.ctx.holds.record(rest)
    if (rest.length === 0) await this.ctx.holds.setNoted(false)
    this.ctx.onHeld(rest.length)
  }

  /** The deletes a commit sent that nobody confirmed, counted toward the guard's window. */
  async tallySent(ops: readonly CommitOp[], confirmed: ReadonlySet<string>): Promise<void> {
    const count = ops.filter((op) => op.op === 'delete' && !confirmed.has(op.file_id)).length
    await this.ctx.holds.tally(this.ctx.now(), count, this.deleteWindow())
  }

  /** How long sent deletes count toward the guard. */
  private deleteWindow(): number {
    const guard = this.ctx.deleteGuard
    return (guard === false ? undefined : guard?.windowMs) ?? DEFAULT_DELETE_WINDOW_MS
  }

  /**
   * A `restore` decision: the entries of those files are dropped, so the manifest walk this run
   * starts with brings them down again from the server, which never received their deletes. A
   * file back on this disk by now keeps its entry: there is nothing to bring back for it.
   */
  async putBack(decision: DeleteDecision): Promise<void> {
    let dropped = 0
    for (const fileId of decision.fileIds) {
      const entry = await this.ctx.state.byFileId(fileId)
      if (entry === null || (await this.ctx.fs.stat(entry.path)) !== null) continue
      await this.ctx.state.delete(entry.path)
      dropped++
    }
    // Only the files decided about leave the hold; the rest wait for a decision of their own.
    const decided = new Set(decision.fileIds)
    const rest = (await this.ctx.holds.list()).filter((one) => !decided.has(one.fileId))
    await this.ctx.holds.record(rest)
    // The walk this rewinds to brings every change a walk passed over, too.
    await this.ctx.holds.setNoted(false)
    this.ctx.onHeld(rest.length)
    this.ctx.log(`sync: putting back ${dropped} held deletions from the vault`)
    this.ctx.rewind()
  }
}
