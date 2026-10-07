import type { CommitOp } from '@abele/sync-protocol'
import type { ScanFilter } from './scanner.js'
import { isEngineOwn } from './selective.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * The mass-delete guard.
 *
 * A scan that would delete many files at once is more often a disk that went missing, an
 * index not ready yet or a sync tool gone wrong than a person tidying up. So such a run sends
 * everything but those deletes, keeps their paths clear of the pulls exactly as an unsent
 * delete's are, and waits for the person: `confirm` sends them, `restore` brings the files back
 * from the server, which never received the deletes.
 *
 * Only `delete` ops count. A rename is a move and is not counted; a move into a folder this
 * device does not sync is a delete on the wire (decision 9), and counts as one. A replayed
 * journal is never judged: that batch is already the server's to take.
 *
 * A hold lasts until the person decides: a delete held once stays held
 * however few are left, and only deletes the hold does not have yet are judged, joining it when
 * they trip the guard themselves. A file that comes back leaves the hold, since the scan no longer
 * sends its delete. Deletes that went out recently count toward the next judgement too, so a tool
 * removing a few files every sync is caught once they add up; a decision starts that count again.
 */

/**
 * When a scan's deletes are held: at least `count` of them, or at least `floor` that are also
 * at least `share` of the entries this device syncs. `false` turns the guard off.
 */
export interface DeleteGuard {
  count: number
  floor: number
  share: number
  /** How long a delete that went out still counts toward the next; 15 minutes by default. */
  windowMs?: number
}

/** How long sent deletes count toward the guard when a host names no window. */
export const DEFAULT_DELETE_WINDOW_MS = 15 * 60 * 1000

/** 50 deletes, or 10 that are a quarter of the vault (GUESS-14, not settable yet). */
export const DEFAULT_DELETE_GUARD: DeleteGuard = {
  count: 50,
  floor: 10,
  share: 0.25,
  windowMs: DEFAULT_DELETE_WINDOW_MS,
}

/** A delete the guard is holding: the file's wire path and its id. */
export interface HeldDelete {
  path: string
  fileId: string
}

/**
 * What the person decided about the deletes the guard held, filed by a host — the plugin
 * through `SyncEngine.decideDeletes`, the command line straight into the state — and taken
 * by the engine at the start of its next run.
 * - `confirm`: these file ids pass the guard and do not count toward it; later deletes are
 *   judged afresh.
 * - `restore`: their entries are dropped and the feed rewound to the manifest, so the files
 *   come back from the server's live copies. Nothing comes out of the trash.
 */
export interface DeleteDecision {
  kind: 'confirm' | 'restore'
  fileIds: string[]
  /** When it was decided, ISO-8601; for a person reading the state, not for the engine. */
  at: string
}

/** Where a host files a decision. */
export const DELETE_DECISION_KEY = 'delete-decision'
/** Where the engine files what it holds, for a host in another process to list. */
export const HELD_DELETES_KEY = 'held-deletes'
/** Where the engine files the deletes it sent lately: `[at, count]` pairs, in its own clock. */
const RECENT_DELETES_KEY = 'recent-deletes'
/**
 * Set when a manifest walk passed over a remote change to a held path rather than walk again for
 * it (item 7): when that path leaves the hold with no decision, the vault is walked once more so
 * the change it missed arrives.
 */
const NOTED_KEY = 'held-noted'

/** Whether this many deletes, of this many synced entries, are held. */
export function tripsGuard(deletes: number, inScope: number, guard: DeleteGuard): boolean {
  if (deletes >= guard.count) return true
  return deletes >= guard.floor && inScope > 0 && deletes / inScope >= guard.share
}

/** What a scan's ops come to under the guard. */
export interface Judged {
  /** Every op but the held deletes, in the scan's order. */
  send: CommitOp[]
  held: HeldDelete[]
  /** The entries this device syncs, which the share is taken of. */
  inScope: number
  /** The deletes sent that nobody confirmed: what counts toward the next judgement. */
  counted: number
}

/** What the guard knows beyond the scan: the hold so far, and the deletes sent lately. */
export interface JudgeContext {
  /** File ids held already and not decided: they stay held. */
  sticky?: ReadonlySet<string>
  /** Deletes sent within the guard's window, which count with the new ones. */
  recent?: number
}

/**
 * Split a scan's ops into what is sent and what is held. Deletes of `confirmed` file ids are
 * always sent and not counted. Deletes of `sticky` ids stay held. The rest are judged together
 * with the `recent` ones, and are held together or sent together.
 */
export function judgeDeletes(
  ops: CommitOp[],
  entries: Iterable<StateEntry>,
  filter: ScanFilter,
  confirmed: ReadonlySet<string>,
  guard: DeleteGuard | false,
  context: JudgeContext = {}
): Judged {
  const byId = new Map<string, StateEntry>()
  let inScope = 0
  for (const entry of entries) {
    byId.set(entry.fileId, entry)
    if (!isEngineOwn(entry.wirePath) && !filter.excluded(entry.wirePath, entry.size)) inScope++
  }
  const unconfirmed = ops.filter(
    (op): op is Extract<CommitOp, { op: 'delete' }> =>
      op.op === 'delete' && !confirmed.has(op.file_id)
  )
  if (guard === false) return { send: ops, held: [], inScope, counted: unconfirmed.length }
  const sticky = context.sticky ?? new Set<string>()
  const fresh = unconfirmed.filter((op) => !sticky.has(op.file_id))
  const recent = context.recent ?? 0
  // The share is of what is left once the hold is set aside — a folder emptying bit by bit is
  // judged against what it still had — and of the recent deletes, gone from the entries already.
  const base = inScope - (unconfirmed.length - fresh.length) + recent
  const trips = fresh.length > 0 && tripsGuard(fresh.length + recent, base, guard)
  const holding = new Set(
    unconfirmed.filter((op) => sticky.has(op.file_id) || trips).map((op) => op.file_id)
  )
  if (holding.size === 0) return { send: ops, held: [], inScope, counted: unconfirmed.length }
  return {
    send: ops.filter((op) => op.op !== 'delete' || !holding.has(op.file_id)),
    held: unconfirmed
      .filter((op) => holding.has(op.file_id))
      .map((op) => ({
        path: byId.get(op.file_id)?.wirePath ?? op.file_id,
        fileId: op.file_id,
      })),
    inScope,
    counted: unconfirmed.length - holding.size,
  }
}

/** A filed decision, or null for none or for anything that is not one. */
export function parseDecision(raw: string | null): DeleteDecision | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<DeleteDecision> | null
    if (value === null || typeof value !== 'object') return null
    if (value.kind !== 'confirm' && value.kind !== 'restore') return null
    if (!Array.isArray(value.fileIds) || !value.fileIds.every((id) => typeof id === 'string')) {
      return null
    }
    return {
      kind: value.kind,
      fileIds: value.fileIds,
      at: typeof value.at === 'string' ? value.at : '',
    }
  } catch {
    return null
  }
}

/** The filed held deletes, or none. */
export function parseHeld(raw: string | null): HeldDelete[] {
  if (raw === null) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter(
      (item): item is HeldDelete =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as HeldDelete).path === 'string' &&
        typeof (item as HeldDelete).fileId === 'string'
    )
  } catch {
    return []
  }
}

/**
 * File a decision for the engine's next run, from a host that has only the state: the
 * command line beside a running daemon, or before `run`. A store without meta cannot carry
 * one across processes; such a host decides through `SyncEngine.decideDeletes`.
 */
export async function fileDeleteDecision(
  state: StateStore,
  decision: DeleteDecision
): Promise<void> {
  if (!state.setMeta) throw new Error('this state store cannot file a decision')
  await state.setMeta(DELETE_DECISION_KEY, JSON.stringify(decision))
}

/** The deletes the engine last held, as filed in the state; none for a store without meta. */
export async function readHeldDeletes(state: StateStore): Promise<HeldDelete[]> {
  return parseHeld(state.getMeta ? await state.getMeta(HELD_DELETES_KEY) : null)
}

/** The decision filed and not yet taken, if any. */
export async function readDeleteDecision(state: StateStore): Promise<DeleteDecision | null> {
  return parseDecision(state.getMeta ? await state.getMeta(DELETE_DECISION_KEY) : null)
}

/**
 * The engine's side of the guard's bookkeeping: the decision a host filed, and what the engine
 * holds, in the state's meta where the store has it — so the command line in another process
 * can list the one and file the other — and in memory where it does not.
 */
export class DeleteHolds {
  private memoryDecision: string | null = null
  private memoryHeld: HeldDelete[] = []
  private memoryRecent: Array<[number, number]> = []
  private memoryNoted = false
  /** The wire paths held, as last filed; loaded from the state once per engine. */
  private paths: Set<string> | null = null

  constructor(private readonly state: StateStore) {}

  /** The decision waiting to be taken, and its text as filed, to clear only that one. */
  async decision(): Promise<{ decision: DeleteDecision; raw: string } | null> {
    const raw = this.state.getMeta
      ? await this.state.getMeta(DELETE_DECISION_KEY)
      : this.memoryDecision
    const decision = parseDecision(raw)
    return decision === null || raw === null ? null : { decision, raw }
  }

  /**
   * Forget a decision once it is carried out — unless another has been filed over it since,
   * which is then the next run's. Anything that is not a decision is forgotten too.
   */
  async settle(raw: string): Promise<void> {
    if (!this.state.getMeta || !this.state.setMeta) {
      if (this.memoryDecision === raw) this.memoryDecision = null
      return
    }
    const now = await this.state.getMeta(DELETE_DECISION_KEY)
    if (now === raw || (now !== null && parseDecision(now) === null)) {
      await this.state.setMeta(DELETE_DECISION_KEY, null)
    }
  }

  /** File a decision for the next run. */
  async decide(decision: DeleteDecision): Promise<void> {
    const raw = JSON.stringify(decision)
    if (this.state.setMeta) await this.state.setMeta(DELETE_DECISION_KEY, raw)
    else this.memoryDecision = raw
  }

  /** What is held now. */
  async list(): Promise<HeldDelete[]> {
    if (!this.state.getMeta) return [...this.memoryHeld]
    return parseHeld(await this.state.getMeta(HELD_DELETES_KEY))
  }

  /** The wire paths held, which no pull may write over. */
  async held(): Promise<Set<string>> {
    this.paths ??= new Set((await this.list()).map((one) => one.path))
    return this.paths
  }

  /** File what this run holds; true when it is not what was held before. */
  async record(held: HeldDelete[]): Promise<boolean> {
    const before = await this.list()
    const same =
      before.length === held.length && before.every((one, at) => one.fileId === held[at]?.fileId)
    this.paths = new Set(held.map((one) => one.path))
    if (same) return false
    if (this.state.setMeta) {
      await this.state.setMeta(HELD_DELETES_KEY, held.length === 0 ? null : JSON.stringify(held))
    } else {
      this.memoryHeld = [...held]
    }
    return true
  }

  /** How many deletes went out within `windowMs` of `now`. */
  async recent(now: number, windowMs: number): Promise<number> {
    return (await this.recentPairs())
      .filter(([at]) => at > now - windowMs && at <= now)
      .reduce((sum, [, count]) => sum + count, 0)
  }

  /** Count `count` deletes that went out at `now`, forgetting those past the window. */
  async tally(now: number, count: number, windowMs: number): Promise<void> {
    if (count <= 0) return
    const kept = (await this.recentPairs()).filter(([at]) => at > now - windowMs && at <= now)
    await this.writeRecent([...kept, [now, count]])
  }

  /** A decision was made: what went out before it counts no more. */
  async resetTally(): Promise<void> {
    if ((await this.recentPairs()).length > 0) await this.writeRecent([])
  }

  /** Whether a walk passed over a remote change to a held path; see `NOTED_KEY`. */
  async noted(): Promise<boolean> {
    if (!this.state.getMeta) return this.memoryNoted
    return (await this.state.getMeta(NOTED_KEY)) !== null
  }

  async setNoted(noted: boolean): Promise<void> {
    if (!this.state.setMeta) {
      this.memoryNoted = noted
      return
    }
    if ((await this.noted()) === noted) return
    await this.state.setMeta(NOTED_KEY, noted ? '1' : null)
  }

  private async recentPairs(): Promise<Array<[number, number]>> {
    if (!this.state.getMeta) return [...this.memoryRecent]
    const raw = await this.state.getMeta(RECENT_DELETES_KEY)
    if (raw === null) return []
    try {
      const value: unknown = JSON.parse(raw)
      if (!Array.isArray(value)) return []
      return value.filter(
        (pair): pair is [number, number] =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          typeof pair[0] === 'number' &&
          typeof pair[1] === 'number'
      )
    } catch {
      return []
    }
  }

  private async writeRecent(pairs: Array<[number, number]>): Promise<void> {
    if (!this.state.setMeta) {
      this.memoryRecent = pairs
      return
    }
    await this.state.setMeta(RECENT_DELETES_KEY, pairs.length === 0 ? null : JSON.stringify(pairs))
  }
}
