import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineStatus } from '@abele/sync-core'
import { ensureStateFolder, stateFolder } from './config.js'

/**
 * What is left of the push a daemon is running, counted down as it goes (B14).
 *
 * The engine lowers `pending` op by op while a push runs — each file once its bytes are on the
 * server, each batch once it is recorded — which is what a plugin's status bar counts down
 * with. A daemon has no status bar: `status` runs in another process and scans the disk, and
 * the state only learns a file is through once its whole batch is recorded, so the scan's count
 * stands still until the push is over. So the daemon files the engine's count in a small file
 * beside the state for `status` to read, and says it now and then for the log and the console.
 *
 * A file rather than the state database: the engine may hold a transaction open across a
 * batch, and a count written inside it would reach another process only when the batch does.
 */

/** How often the count is filed at most while it falls. */
export const PROGRESS_FILE_MS = 250
/** How often the log and the console are told what is left at most. */
export const PROGRESS_LINE_MS = 5_000

const LIVE_FILE = 'live'

export interface ProgressTiming {
  fileMs: number
  lineMs: number
}

export interface PushProgressOptions extends ProgressTiming {
  /** Files the count, or clears it with null. */
  file: (pending: number | null) => void
  /** A line for the log and the console. */
  say: (line: string) => void
  now?: () => number
}

/** The engine's status as it changes, turned into a filed count and an occasional line. */
export class PushProgress {
  private readonly now: () => number
  /** Whether a sync is running, as the last status said. */
  private syncing = false
  /** The most this sync has had left: what the lines count down from. */
  private total = 0
  private filed: number | null = null
  private filedAt = 0
  /** The count the last line said, or where this sync started when none has yet. */
  private said = 0
  private saidAt = 0

  constructor(private readonly opts: PushProgressOptions) {
    this.now = opts.now ?? (() => Date.now())
  }

  update(status: EngineStatus): void {
    const now = this.now()
    if (status.state !== 'syncing') {
      if (this.syncing) this.file(null, now)
      this.syncing = false
      return
    }
    const pending = status.pending
    if (!this.syncing) {
      this.syncing = true
      this.total = pending
      this.said = pending
      this.saidAt = now
      this.file(pending, now)
      return
    }
    // The scan's count arrives once the sync is under way; everything after it only falls.
    if (pending > this.total) {
      this.total = pending
      this.said = pending
    }
    if (pending !== this.filed && now - this.filedAt >= this.opts.fileMs) this.file(pending, now)
    if (pending < this.said && now - this.saidAt >= this.opts.lineMs) {
      this.said = pending
      this.saidAt = now
      this.opts.say(`push: ${pending} of ${this.total} left`)
    }
  }

  /** The daemon is stopping: nothing of its count may outlive it. */
  end(): void {
    if (this.syncing || this.filed !== null) this.opts.file(null)
    this.syncing = false
    this.filed = null
  }

  /** Nothing left is no count: once the push is recorded the scan in `status` is right again. */
  private file(pending: number | null, now: number): void {
    this.filed = pending
    this.filedAt = now
    this.opts.file(pending === 0 ? null : pending)
  }
}

interface LiveRecord {
  pid: number
  pending: number
  at: string
}

/**
 * Files the count as this process's, through a temp file; null removes it — only when it is this
 * process's, since a daemon that lost the lock may clear up after the one that took it over.
 */
export function writeLive(dir: string, pending: number | null): void {
  const file = join(stateFolder(dir), LIVE_FILE)
  if (pending === null) {
    if (readLive(dir)?.pid === process.pid) rmSync(file, { force: true })
    return
  }
  const folder = ensureStateFolder(dir)
  const temp = join(folder, `${LIVE_FILE}.${process.pid}`)
  const record: LiveRecord = { pid: process.pid, pending, at: new Date().toISOString() }
  writeFileSync(temp, `${JSON.stringify(record)}\n`)
  renameSync(temp, file)
}

/** The filed count, or null when there is none or it cannot be read. */
export function readLive(dir: string): LiveRecord | null {
  try {
    const record = JSON.parse(readFileSync(join(stateFolder(dir), LIVE_FILE), 'utf8')) as unknown
    if (typeof record !== 'object' || record === null) return null
    const { pid, pending, at } = record as Partial<LiveRecord>
    if (typeof pid !== 'number' || typeof pending !== 'number' || typeof at !== 'string') {
      return null
    }
    return { pid, pending, at }
  } catch {
    return null
  }
}

/**
 * What the daemon running this vault has left to push, or null when no push of a live daemon is
 * running. `daemon` names the pid of the daemon holding the vault's lock here (`localDaemon`):
 * a count filed by any other process — one killed mid-push — counts for nothing.
 */
export function liveCount(dir: string, daemon: (dir: string) => number | null): number | null {
  const record = readLive(dir)
  if (record === null) return null
  return daemon(dir) === record.pid ? record.pending : null
}
