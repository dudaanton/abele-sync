import type { ChangeItem } from '@abele/sync-protocol'
import type { VaultClient } from './client.js'
import type { ExpectedWrites } from './echo.js'
import type { FileSystem } from './fs.js'
import { Puller } from './pullRun.js'
import type { PersonalNoteHook } from './personalNoteEvents.js'
import type { ScanFilter } from './scanner.js'
import type { Staged } from './defer.js'
import type { StateStore } from './state.js'

/**
 * The puller: the server's changes brought onto this disk, and never over a local edit.
 *
 * It follows the feed from the cursor the state kept, applies each change in seq order,
 * and stops the cursor short of the first change it could not safely take. A change is
 * held when the file it names, or the path it lands on, has an edit this device has not
 * pushed yet: the engine pushes, the server says who won, and the next pull — which
 * starts again from just before the held change — applies whatever the server settled on.
 *
 * Re-applying is therefore normal, and cheap: a change whose version this device already
 * has is recognised and skipped, so the changes between the held one and the head are
 * re-read but not re-written. Within one page only the last change to each file is applied
 * at all — the earlier ones describe versions the later one has already replaced, and
 * writing each in turn would put text on the disk only to write over it a moment later.
 *
 * Nothing here writes a commit. The puller only ever brings things down.
 */

export interface PullOptions {
  /** Personal note deliveries keep automatic reactions enabled, including shared edits.
   * Persist this exact-version event for delayed native cache acknowledgement. */
  onPersonalNoteApplied?: PersonalNoteHook
  /** Which files this device syncs at all; an excluded change is passed over. */
  filter: ScanFilter
  /** Wire paths with a local edit in flight: the scan's `dirty`, plus whatever the push holds. */
  dirty: Set<string>
  /** Staged file IDs whose tracked source must still exist; absence is a local edit for them. */
  preserveMissing?: ReadonlySet<string>
  /** The registry the host's watcher checks, so the engine does not push its own writes back. */
  expected: ExpectedWrites
  /**
   * File ids back in this device's scope with their file still on the disk (`ScopeMarks`). A
   * run that walks the whole manifest and the feed after it and meets none of a file's changes
   * has learned the server deleted it while this device was not looking: its unedited copy
   * goes here too. Ignored by a run that does not walk the manifest, or does not finish it.
   */
  recheck?: Set<string>
  /**
   * Told of every server file passed over because a local file this device does not sync lies
   * at its path, with that local file's path on this disk. The cursor moves past the change,
   * so the host must walk the manifest again once that local file has gone (`AsideMarks`).
   * Awaited before the cursor is saved past that change, so the host files its mark first.
   */
  onAside?: (path: string, wirePath: string) => void | Promise<void>
  /**
   * Which wire paths are staged rather than written (`EngineOptions.defer`). A change to one —
   * or one moving a file off one — goes to `onDefer`, and the cursor moves past it as if it had
   * been applied. A change whose bytes the disk already holds where they belong is taken as
   * usual: nothing would be written for it.
   */
  defer?: (wirePath: string) => boolean
  /**
   * Told of the changes a page staged, each with the version its file's entry had then.
   * Awaited before the cursor is saved past them, so the host files them first. It may answer
   * how many of them were news — not staged already — which is what the report counts.
   */
  onDefer?: (staged: Staged[]) => number | void | Promise<number | void>
  /**
   * Wire paths whose deletes the guard holds for a decision. A manifest walk passes over a remote
   * change to one of them — noted, not held — so the hold does not leave the cursor at 0 and every
   * later sync walking the whole vault again. The decision settles the
   * file either way: a confirm sends the delete, which the server answers with the edit, and a
   * restore walks the vault again. The feed still holds such a change, as ever.
   */
  noted?: Set<string>
  /** How many blobs to fetch at once. */
  concurrency?: number
  /**
   * How many downloaded bytes a page may hold before they are written: the page is taken in
   * runs that fit, one file bigger than the whole budget making a run of its own. 64 MiB when
   * unset. A first pull of a vault of large attachments would otherwise hold a whole page —
   * up to a thousand files — in memory at once.
   */
  prefetchBytes?: number
  /** The digest, `sha256` by default. Local bytes and downloaded ones alike are checked with it. */
  hash?: (bytes: Uint8Array) => Promise<string>
  log?: (message: string) => void
}

export interface PullReport {
  /** Changes this run brought onto the disk. */
  applied: number
  /** Changes the local edits made it unsafe to apply, in the order they were read. */
  held: ChangeItem[]
  /**
   * Changes this device does not sync, changes it already had, changes a later one on the
   * same page superseded, and changes whose paths the wire would never carry.
   */
  skipped: number
  /** Where the cursor now stands: just before the first held change, or at the head. */
  cursor: number
  /**
   * Changes this pull staged for the host rather than wrote (`PullOptions.defer`) that were not
   * staged already: a rewound walk that meets a staged change again does not count it twice.
   */
  deferred: number
  /** True when the run walked the manifest rather than the feed. */
  bootstrapped: boolean
  /** Changes a manifest walk passed over for a held delete (`PullOptions.noted`); absent for none. */
  noted?: number
  /**
   * File ids whose held delete (`PullOptions.noted`) the server's own delete settled: gone on
   * both sides, so their entries went and the hold has nothing left to ask about them. Absent
   * for none.
   */
  settled?: string[]
}

/**
 * Bring this device level with the server, or as level as the local edits allow.
 *
 * The cursor is persisted as the run goes, so a pull that is cut off leaves the state
 * pointing at the last page it finished rather than at the beginning.
 */
export async function pull(
  client: VaultClient,
  fs: FileSystem,
  state: StateStore,
  opts: PullOptions
): Promise<PullReport> {
  const report: PullReport = {
    applied: 0,
    held: [],
    skipped: 0,
    cursor: await state.getCursor(),
    bootstrapped: false,
    deferred: 0,
  }
  await new Puller(client, fs, state, opts, report).run()
  return report
}

/**
 * Apply changes staged earlier (`PullOptions.defer`), as a pull would have: in seq order, never
 * over a local edit, and without touching the cursor, which is already past them. What a local
 * edit stood in the way of comes back in `held`; everything else was applied or needed nothing.
 */
export async function applyStaged(
  client: VaultClient,
  fs: FileSystem,
  state: StateStore,
  changes: ChangeItem[],
  opts: Omit<PullOptions, 'defer' | 'onDefer' | 'recheck'>
): Promise<PullReport> {
  const report: PullReport = {
    applied: 0,
    held: [],
    skipped: 0,
    cursor: await state.getCursor(),
    bootstrapped: false,
    deferred: 0,
  }
  const ordered = [...changes].sort((a, b) => a.seq - b.seq)
  await new Puller(client, fs, state, opts, report).apply(ordered)
  return report
}
