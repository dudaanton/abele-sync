import { caseKey, normalisePath, type CommitOp } from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import { touchesDeferred } from './defer.js'
import type { FileSystem } from './fs.js'
import type { ResumeOptions } from './pusher.js'
import type { StateEntry, StateStore } from './state.js'

/**
 * The pusher's view of this disk while it takes a commit's verdicts: where a file lies now,
 * whether it is still what was sent, and a file's old place given up for its new one.
 */

/** A disk saying something that is not a file holds the path: the adapter's `conflict`. */
export const inTheWay = (error: unknown): boolean =>
  error instanceof EngineError && error.code === 'conflict'

/** What a version holds, as an op sends it and as a result answers with it. */
export interface Content {
  sha: string
  size: number
  mtime: number
}

/**
 * What the op said the file was when the scan read it: its own bytes for a create or a
 * modify, and whatever the file already held for a move or a delete, which carry none.
 */
export function sentBy(op: CommitOp, previous: StateEntry | null): Content | null {
  if (op.op === 'create' || op.op === 'modify') return op
  if (op.op === 'restore') return null
  return previous
}

/** The adapters one push runs over, and the spellings its scan found. */
export class PushDisk {
  constructor(
    private readonly fs: FileSystem,
    private readonly state: StateStore,
    private readonly opts: ResumeOptions,
    private readonly hash: (bytes: Uint8Array) => Promise<string>,
    /** wirePath → the on-disk spelling, as the scan found it; empty on a replay. */
    private readonly diskPaths: Map<string, string>
  ) {}

  /**
   * Where the file a verdict is about lies right now: at the target, or — when nothing is
   * there yet — where this device last had it. A server that lands an edit at a path the head
   * had moved to names a target this disk has not caught up with; `place` carries the file
   * over only once the verdict is taken, so before then the file to look at is the old one.
   */
  async whereIs(previous: StateEntry | null, target: string): Promise<string> {
    if (previous === null || previous.path === target) return target
    if ((await this.fs.stat(target)) !== null) return target
    return (await this.fs.stat(previous.path)) === null ? target : previous.path
  }

  /**
   * Whether the file still holds the actual submitted content: size, mtime and SHA,
   * the entry's own for a move, and no file at all for a delete.
   *
   * This is the same test the scanner uses to call a file unchanged, and it is deliberately
   * the op's word rather than the state's — the state still describes the version before
   * this batch, and it is what was *sent* that the bytes coming back would write over.
   */
  async untouched(op: CommitOp, sent: Content | null, file: string): Promise<boolean> {
    const have = await this.fs.stat(file)
    // A delete the head outlived: the file the scan found gone must still be gone.
    if (op.op === 'delete') return have === null
    if (have === null) return false
    if (sent === null || have.size !== sent.size || have.mtime !== sent.mtime) return false
    // A negative holds() read is not replacement authority. Preserved/rounded
    // metadata cannot prove that the bytes still match the submitted operation.
    try {
      const bytes = await this.fs.read(file)
      if (bytes.length !== sent.size || (await this.hash(bytes)) !== sent.sha) return false
      const after = await this.fs.stat(file)
      return after !== null && after.size === have.size && after.mtime === have.mtime
    } catch {
      return false
    }
  }

  /**
   * The file's old place, given up now the server has said where it lives.
   *
   * Usually the op itself already moved it and there is only the old row to drop. A server
   * that lands a file somewhere else — an edit whose head had moved in the meantime — is
   * followed rather than argued with, so the disk and the state say the same thing and the
   * next scan has nothing to undo. When something already lies at the target — a create of
   * this device's that the server merged into a file another device had moved there — the
   * synced copy at the old path is the same file under its old name, and goes; one that has
   * been edited since is somebody's typing, and stays for the next scan to send as its own.
   *
   * Except when the two names are one name to a case- and normalisation-insensitive disk:
   * then a `stat` of the old spelling finds the very file at the target, and removing it
   * would unlink the only copy. That file is renamed to the target's spelling instead.
   */
  async place(previous: StateEntry | null, target: string): Promise<boolean> {
    if (previous === null || previous.path === target) return true
    const old = await this.fs.stat(previous.path)
    if (old !== null) {
      try {
        const there = await this.fs.stat(target)
        if (there === null) await this.fs.move(previous.path, target)
        else if (caseKey(previous.path) === caseKey(target)) {
          await this.respell(previous.path, target, old, there)
        } else if (old.size === previous.size && old.mtime === previous.mtime) {
          await this.fs.remove(previous.path)
        }
      } catch (error) {
        if (!inTheWay(error)) throw error
        this.opts.log?.(`push: ${target} cannot be taken: ${(error as Error).message}`)
        return false
      }
    }
    this.opts.expected.clear(previous.path)
    await this.state.delete(previous.path)
    return true
  }

  /**
   * Two spellings of one name, both answering a `stat`. On a case-insensitive disk that is one
   * file, which takes the target's spelling; on a case-sensitive one they are two files, and
   * neither is removed — the one at the old spelling is left for the next scan to describe.
   * Only a file whose size, mtime and bytes are the same through both names is renamed, and a
   * rename the disk refuses (two identical files, case-sensitively) leaves both as they are.
   */
  private async respell(
    from: string,
    to: string,
    old: { size: number; mtime: number },
    there: { size: number; mtime: number }
  ): Promise<void> {
    if (old.size !== there.size || old.mtime !== there.mtime) return
    const [a, b] = await Promise.all([this.fs.read(from), this.fs.read(to)])
    if ((await this.hash(a)) !== (await this.hash(b))) return
    try {
      await this.fs.move(from, to)
    } catch (error) {
      if (!(error instanceof EngineError) || error.code === 'lost') throw error
      this.opts.log?.(`push: ${from} stays beside ${to}: ${error.message}`)
    }
  }

  /**
   * A rename the server refused goes back where the entry says it was, so the next pull can
   * put the file where the winner did. Only when the file at the new path is still the one
   * the entry describes, by size and mtime, and the old path is free; anything else — a file
   * that went, one edited since the scan, a file that has since taken the old name — is left
   * where it is for the scan to describe again.
   */
  async undoMove(op: Extract<CommitOp, { op: 'move' }>): Promise<void> {
    const previous = await this.state.byFileId(op.file_id)
    if (previous === null) return
    if (touchesDeferred(this.opts.defer, previous.wirePath, op.to_path)) {
      this.opts.log?.(`push: the refused move of ${op.to_path} stays local pending staged approval`)
      return
    }
    const at = this.diskPaths.get(op.to_path) ?? (await this.spelling(op.to_path))
    const have = await this.fs.stat(at)
    if (have === null || (await this.fs.stat(previous.path)) !== null) return
    if (have.size !== previous.size || have.mtime !== previous.mtime) {
      this.opts.log?.(`push: ${at} changed since the scan; the refused move is left as it is`)
      return
    }
    try {
      await this.fs.move(at, previous.path)
    } catch (error) {
      if (!inTheWay(error)) throw error
      this.opts.log?.(`push: ${at} stays: ${(error as Error).message}`)
      return
    }
    this.opts.log?.(`push: ${at} is back at ${previous.path}`)
  }

  /**
   * Where on this disk the file a result names lives.
   *
   * The entry's own spelling wins where it is the same path — an NFD disk keeps its own
   * decomposition of an NFC wire path — then the spelling the scan found, then the wire's.
   */
  async targetOf(path: string, fileId: string): Promise<string> {
    const entry = await this.state.byFileId(fileId)
    if (entry !== null && normalisePath(entry.path) === path) return entry.path
    return this.diskPaths.get(path) ?? this.spelling(path)
  }

  /**
   * Which spelling of a wire path this disk uses, when there is no scan to ask — a replay
   * has none, and the journal carries the ops, which speak the wire's NFC, and nothing about
   * the disk. A disk that decomposes holds the NFD form of the same name, so whichever of
   * the two a `stat` finds is the file; a path with no file at all is recorded as the wire
   * spells it, which is what a fresh scan would then find and adopt.
   */
  private async spelling(path: string): Promise<string> {
    if ((await this.fs.stat(path)) !== null) return path
    const decomposed = path.normalize('NFD')
    if (decomposed !== path && (await this.fs.stat(decomposed)) !== null) return decomposed
    return path
  }

  /** Whether the file at `path` is already the bytes named. */
  async holds(path: string, sha: string): Promise<boolean> {
    try {
      if ((await this.fs.stat(path)) === null) return false
      return (await this.hash(await this.fs.read(path))) === sha
    } catch {
      // It was there a moment ago and cannot be read now: write it, rather than assume.
      return false
    }
  }
}
