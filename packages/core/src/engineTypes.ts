import { AbeleError, type JoinPrefer } from '@abele/sync-protocol'
import type { VaultClient } from './client.js'
import type { DeleteGuard } from './deletes.js'
import { EngineError } from './errors.js'
import type { FileSystem } from './fs.js'
import type { PathMatcher } from './ignore.js'
import type { PullReport } from './puller.js'
import type { PushReport } from './pusher.js'
import type { CaseCollision } from './scanner.js'
import type { SelectiveSettings } from './selective.js'
import type { StateStore } from './state.js'
import type { OwnerPushHooks } from './ownerHooks.js'
import type { PersonalNoteHook } from './personalNoteEvents.js'
import type { RecoveryReadiness } from './external/recovery.js'

/**
 * What the engine is told and what it tells: its options, its status, the report of one sync,
 * and how a failure is read. `engine.ts` re-exports the public ones.
 */

export type EngineState = 'idle' | 'syncing' | 'offline' | 'paused' | 'error'

/**
 * What a failed sync means for what happens next.
 *
 * `offline` is a server that could not be reached; `unauthorized` is a token the server no
 * longer takes, which no retry will change; `other` is tried again on the next trigger.
 */
export type SyncFailure = 'offline' | 'unauthorized' | 'other'

export interface EngineStatus {
  state: EngineState
  /**
   * Ops the last scan found, from the scan until the push has recorded them; then the paths
   * that push left for the next one — files that changed while it was in the air, and the
   * files of ops the server refused. Paths, not ops, after the push: a refused move counts
   * both ends, since both are the next scan's to settle.
   */
  pending: number
  /** When the last sync finished, ISO-8601, or null before the first one has. */
  lastSyncAt: string | null
  /** What the last failure said, cleared by the next sync that gets through. */
  lastError: string | null
  /** The feed position the state holds: every change up to it is on this disk or held. */
  cursor: number
  /** The vault's head, as last heard from the server, or null before it has been asked. */
  headSeq: number | null
  /**
   * Deletes the guard is holding for a decision (see `EngineOptions.deleteGuard`), 0 when
   * none. Always set by the engine; optional only so a host's own status literals still type.
   */
  heldDeletes?: number
  /**
   * Changes staged for the host rather than written (see `EngineOptions.defer`), 0 when none.
   * Always set by the engine; optional so a host's own status literals still type.
   */
  deferred?: number
}

export interface EngineOptions extends OwnerPushHooks {
  onPersonalNoteApplied?: PersonalNoteHook
  client: VaultClient
  fs: FileSystem
  state: StateStore
  selective: SelectiveSettings
  /** The vault's `.abele-sync-ignore`, parsed; a path it ignores is neither pushed nor pulled. */
  ignore?: PathMatcher
  /**
   * The text `ignore` was parsed from, or null for no ignore file. Filed with the scope the
   * out-of-scope marks were taken under, so a later engine on another scope can tell what this
   * one left out (see `ScopeMarks`). A host that leaves it out still gets its marks taken.
   */
  ignoreText?: string | null
  /** The folder whose files count as scripts; `Scripts` by default. */
  scriptsFolder?: string
  /** How long the watcher's reports are collected before they are looked at; 300 ms by default. */
  debounceMs?: number
  /** The first and the longest wait before trying a server again: `[2 s, 60 s]` by default. */
  backoffMs?: [number, number]
  /** How often to sync with nothing prompting it; five minutes by default. */
  fallbackMs?: number
  /** The clock `lastSyncAt` reads; `Date.now` by default. */
  now?: () => number
  /** Called with every sync that got through, however it was prompted. */
  onSync?: (report: SyncReport) => void
  /** Called with every sync that did not, and what kind of failure it was. */
  onFail?: (error: unknown, kind: SyncFailure) => void
  log?: (line: string) => void
  /**
   * The side this device takes while it joins a vault it already had files for, on every
   * file the two hold at one path with other bytes: `mine` makes this
   * device's bytes the head everywhere, `theirs` keeps the server's here. Either way the other
   * side is a version of that file on the server before anything is written over. Absent is
   * "merge both": notes are merged, anything else goes to the newer mtime.
   *
   * It is sent, as `prefer` on every create, only while the device is joining: a run that
   * starts with the cursor at 0 — a device that has not finished walking the manifest — marks
   * the join open in the state, and every run after it joins too, in this process or the next,
   * until one of them has its push answered. So a join cut off after its first pull moved the
   * cursor is finished by the next run with the same choice. Once this engine has seen the
   * cursor above 0 with no join open, or finished a join's push, it sends none. A `rescan`
   * winds the cursor back, but after the check, so a rescan of a device that has joined sends
   * no preference.
   *
   * The join ends with the first run that walked the manifest and got its push answered:
   * every create it sent has had the chosen side. What the pulls still hold after that — a
   * file the server refused for good, a folder in the way — is ordinary sync, and leaving the
   * cursor at 0 does not keep the device joining.
   *
   * The host owns the choice and must clear it once the join is done, since a fresh process
   * starts with no memory of the guard above: after the first `onSync` report for which
   * `joinFinished(report)` is true it forgets the choice and builds later engines without it.
   * Until then (a join that failed half way, a crash) it passes the same choice again, so the
   * next run finishes the join the way the person asked.
   */
  joinPrefer?: JoinPrefer
  /**
   * Whether this process still holds the vault, asked before every commit, every write to the
   * vault's disk and every write to the state. Once it says no, the run in progress stops at
   * that step with `EngineError('lost')`, as if the process had died there. The daemon
   * hands in its lock's; a host with no lock leaves it out and nothing is asked.
   */
  stillHeld?: () => boolean
  /** Opt-in explicit host recovery. With this port the constructor performs no
   * scope/status work, and mutating entry points/effects require readiness.
   * Omitted preserves legacy hosts until they adopt their recovery barrier.
   */
  recovery?: RecoveryReadiness
  /**
   * When a scan's deletes are held rather than sent (see `deletes.ts`):
   * 50 deletes, or 10 that are a quarter of the synced files, unless a test says otherwise.
   * `false` sends every delete as it comes.
   */
  deleteGuard?: DeleteGuard | false
  /**
   * Which wire paths the pulls stage rather than write (see `defer.ts`):
   * the plugin stages Obsidian's settings, which Obsidian would write back over from memory, and
   * applies them when the person reloads. A staged change moves the cursor on and leaves the
   * disk and the entry alone, so nothing is pushed for it; `deferred()` lists them,
   * `applyDeferred()` writes them and `keepLocal()` sends this device's bytes over them instead —
   * given the version ids the host showed, only the records still at one of them.
   * Absent stages nothing. Every host syncing executable plugin files must provide this gate;
   * the daemon stages other plugins' code and exposes its own explicit approval command.
   */
  defer?: (wirePath: string) => boolean
}

/**
 * Whether a sync finished joining the vault: it was joining, and its push was answered — which
 * a report says by existing. Whatever is still held is not the join's. True for one sync of a
 * join only, however many runs and restarts the join took (`SyncReport.joined`). A host clears
 * `EngineOptions.joinPrefer` after the first such report.
 */
export function joinFinished(report: SyncReport): boolean {
  return report.joined
}

/** What one sync did: the pull before the scan, the push, and the pull after it if there was one. */
export interface SyncReport {
  /** The pull before the push — folded with the one after the scan when the first held anything. */
  pull: PullReport
  push: PushReport
  /** The pull after the push, when the push committed or the pull before it held something. */
  secondPull: PullReport | null
  /** Fresh files the scan held back, a synced file having their name but for case. */
  collisions: CaseCollision[]
  /**
   * Changes staged and waiting for the host once this sync was done (`EngineOptions.defer`).
   * How many of them were news in this sync is `pull.deferred`, plus `push.deferred` (the
   * server's answers staged rather than written), plus `secondPull.deferred`: a host asks the
   * person when that sum is above 0.
   */
  deferred: number
  /**
   * This sync finished joining the vault: it started with the join still open — the cursor at
   * 0, or a join an earlier run began and did not finish, which the state remembers — and its
   * push was answered, with the preference on every create when there was one. False for every
   * other sync.
   */
  joined: boolean
}

export const noop = (): void => undefined

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Which `SyncFailure` an error is.
 *
 * `offline` is what the client says itself for any `fetch` that never connects. A refused
 * token is `unauthorized` in either error's spelling, and `forbidden` is the same for the
 * engine's purposes — no retry will change the answer. Everything else is `other`.
 */
export function classifyFailure(error: unknown): SyncFailure {
  if (error instanceof EngineError) {
    if (error.code === 'offline') return 'offline'
    return error.code === 'unauthorized' ? 'unauthorized' : 'other'
  }
  if (error instanceof AbeleError) {
    return error.code === 'unauthorized' || error.code === 'forbidden' ? 'unauthorized' : 'other'
  }
  return 'other'
}

/** Two pulls of one sync as one report: what both applied, and what the second still held. */
export function fold(first: PullReport, again: PullReport): PullReport {
  return {
    applied: first.applied + again.applied,
    held: again.held,
    skipped: first.skipped + again.skipped,
    cursor: again.cursor,
    bootstrapped: first.bootstrapped || again.bootstrapped,
    deferred: first.deferred + again.deferred,
  }
}

/** A replayed journal and the push that followed it as one report, as `push` itself would give. */
export function foldPush(replayed: PushReport | null, pushed: PushReport): PushReport {
  if (replayed === null) return pushed
  return {
    committed: pushed.committed ?? replayed.committed,
    applied: replayed.applied + pushed.applied,
    merged: replayed.merged + pushed.merged,
    conflicts: replayed.conflicts + pushed.conflicts,
    rejected: [...replayed.rejected, ...pushed.rejected],
    replayed: replayed.replayed || pushed.replayed,
    kept: [...replayed.kept, ...pushed.kept],
    ...(replayed.deferred === undefined && pushed.deferred === undefined
      ? {}
      : { deferred: (replayed.deferred ?? 0) + (pushed.deferred ?? 0) }),
  }
}
