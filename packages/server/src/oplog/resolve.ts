import type { CommitOp, ErrorCode, FileKind, VaultSettings, VersionOp } from '@abele/sync-protocol'

/**
 * What the server knows about the file an op names, live or deleted, plus how the
 * op's base relates to it. `commit.ts` loads this; `decide` only reads it.
 */
export interface HeadState {
  fileId: string
  path: string
  kind: FileKind
  deleted: boolean
  versionId: string
  sha: string | null
  size: number
  mtime: number
  no: number
  /**
   * How the op's `base_version_id` (a restore's `version_id`) stands to this
   * file: a version of it, a version of another file in the vault, or an id the
   * vault has no row for — pruned by retention, or garbage. Only the middle one
   * is the client's mistake; an unknown base is met as a head that has changed,
   * since a device that stayed offline past a retention window did nothing wrong.
   */
  baseIsKnown: BaseKnowledge
  /** That version's blob and path; null unless the base is a version of this file. */
  baseSha: string | null
  basePath: string | null
  /** That version's size and mtime, which a restore writes back. */
  baseSize?: number
  baseMtime?: number
  /**
   * Whether this file has taken in the op's bytes before: `merged` when a merge of it took
   * them in from the same base (none, for a create), `version` when a version of it holds
   * them. Only asked for a create or a modify that races the head; absent, it is neither.
   * A device that cannot record the answer — a case-sensitive disk holding `Image.png` and
   * `image.png` — sends the same op on every sync, and this is what keeps each of those from
   * writing the loser, or the merge, into history once more.
   */
  incoming?: 'merged' | 'version' | null
  /**
   * Whether a version of this file holds the op's exact bytes, whatever `incoming` says: a
   * merge that took them in wrote the merged text, not them, so only a version can bring
   * them back as themselves. Asked with `incoming`; absent, none does.
   */
  incomingVersion?: boolean
}

export type BaseKnowledge = 'yes' | 'other-file' | 'unknown'

export type Decision =
  | {
      kind: 'apply'
      op: VersionOp
      path: string
      sha: string | null
      size: number
      mtime: number
      status: 'applied'
    }
  /** `commit.ts` loads the three blobs and calls `mergeText`. */
  | { kind: 'merge'; path: string; status: 'merged' }
  /** Nothing is written; the client is handed the head and re-downloads it. */
  | { kind: 'head-wins'; status: 'merged' }
  /**
   * Opaque bytes that lost to a newer head: they are written as a version of the
   * file, for *Version history*, and the head is written again after them so it
   * stays what the file holds. The client is handed that head, as for `head-wins`.
   */
  | { kind: 'head-newer'; status: 'merged' }
  /** The incoming bytes go into a conflict copy beside the head. */
  | { kind: 'conflict-file'; status: 'conflict' }
  /** Already in the requested state: a delete of a deleted file, a restore of the head. */
  | { kind: 'noop'; status: 'applied' }
  | { kind: 'reject'; code: ErrorCode; message: string }

/** The ops that carry bytes of their own. */
type ContentOp = Extract<CommitOp, { sha: string }>

/**
 * The decision table of spec §6. Pure: what to do with one op given the head it
 * found and whether its target path is taken by another live file. No I/O here;
 * `commit.ts` gathers the state and carries the decision out.
 */
export function decide(
  op: CommitOp,
  head: HeadState | null,
  settings: VaultSettings,
  pathTaken: boolean
): Decision {
  switch (op.op) {
    case 'create':
      return decideCreate(op, head, settings)
    case 'modify':
      return decideModify(op, head, settings)
    case 'delete':
      return decideDelete(op, head)
    case 'move':
      return decideMove(op, head, pathTaken)
    case 'restore':
      return decideRestore(op, head)
  }
}

const reject = (code: ErrorCode, message: string): Decision => ({ kind: 'reject', code, message })

const apply = (
  op: VersionOp,
  path: string,
  content: { sha: string | null; size: number; mtime: number }
): Decision => ({
  kind: 'apply',
  op,
  path,
  sha: content.sha,
  size: content.size,
  mtime: content.mtime,
  status: 'applied',
})

/**
 * Rows 1–5. `head` is the live file at the path's case key, else null: a create
 * never meets a deleted file (row 5), so a file created where another was
 * deleted is a new file and the old one stays in the trash, restorable beside it.
 */
function decideCreate(
  op: Extract<CommitOp, { op: 'create' }>,
  head: HeadState | null,
  settings: VaultSettings
): Decision {
  if (head === null) return apply('create', op.path, op)
  // The head already holds these bytes: nothing to resolve, nothing to write.
  if (head.sha === op.sha) return { kind: 'noop', status: 'applied' }
  if (op.prefer !== undefined) return joinRace(op, head, op.prefer)
  // Rows 2–4: create against create, resolved like an edit from an empty base.
  return contentRace(op, head, settings)
}

/**
 * A create sent while a device joins a vault it already had files for, with the side the
 * person chose. The same for every kind and whatever the vault's
 * conflict mode or the two mtimes say — the choice was made for exactly those files.
 *
 * `mine` writes the op as a new version of the head: the old head stays the version before
 * it. `theirs` keeps the head and writes the op as a version under it (`head-newer`), unless
 * a version of this file already holds those exact bytes — then nothing is written again.
 * A merge that took them in is not enough: the loser has to be restorable as itself.
 */
function joinRace(
  op: Extract<CommitOp, { op: 'create' }>,
  head: HeadState,
  prefer: 'mine' | 'theirs'
): Decision {
  if (prefer === 'mine') return apply('modify', head.path, op)
  if (head.incoming === 'version' || head.incomingVersion === true) {
    return { kind: 'head-wins', status: 'merged' }
  }
  return { kind: 'head-newer', status: 'merged' }
}

/** Rows 6–11 and 21–23. */
function decideModify(
  op: Extract<CommitOp, { op: 'modify' }>,
  head: HeadState | null,
  settings: VaultSettings
): Decision {
  if (head === null) return notFound(op.file_id)
  if (head.baseIsKnown === 'other-file') return otherFilesBase()
  if (head.versionId === op.base_version_id) return apply('modify', head.path, op)
  // Row 7: modification wins over deletion; the file comes back with the new content.
  if (head.deleted) return apply('modify', head.path, op)
  // Row 23: without the actual base content, a note cannot be safely merged. Keep the
  // head and copy the incoming bytes aside, regardless of conflict mode or old merge metadata.
  // A known delete version has no content either; only creates have a genuine empty base.
  if (head.kind === 'note' && (head.baseIsKnown === 'unknown' || head.baseSha === null))
    return { kind: 'conflict-file', status: 'conflict' }
  // Non-notes still resolve an unknown base by the newer-mtime rule.
  if (head.baseIsKnown === 'unknown') return contentRace(op, head, settings)
  // Row 8: the head only moved since the base; the edit lands at the new path.
  if (head.sha === head.baseSha) return apply('modify', head.path, op)
  return contentRace(op, head, settings)
}

/** Rows 12–14 and 21–23. */
function decideDelete(op: Extract<CommitOp, { op: 'delete' }>, head: HeadState | null): Decision {
  if (head === null) return notFound(op.file_id)
  if (head.baseIsKnown === 'other-file') return otherFilesBase()
  if (head.deleted) return { kind: 'noop', status: 'applied' }
  if (head.versionId === op.base_version_id) {
    return apply('delete', head.path, { sha: null, size: 0, mtime: 0 })
  }
  // Row 14, and row 23: someone changed it since; the change outlives the delete.
  return { kind: 'head-wins', status: 'merged' }
}

/** Rows 15–19 and 21–23. */
function decideMove(
  op: Extract<CommitOp, { op: 'move' }>,
  head: HeadState | null,
  pathTaken: boolean
): Decision {
  if (head === null) return notFound(op.file_id)
  if (head.baseIsKnown === 'other-file') return otherFilesBase()
  if (head.deleted) return reject('not_found', `file ${op.file_id} has been deleted`)
  if (pathTaken) return reject('path_taken', `another file is at ${op.to_path}`)
  const content = { sha: head.sha, size: head.size, mtime: head.mtime }
  if (head.versionId === op.base_version_id) return apply('move', op.to_path, content)
  // Row 17: only the content changed since the base; the move carries the head's blob.
  // Row 23: with no base to compare against, the same — the target is free, so it applies.
  if (head.baseIsKnown === 'unknown' || head.path === head.basePath) {
    return apply('move', op.to_path, content)
  }
  // Row 18: it moved elsewhere in the meantime; the client sees where from the feed.
  return reject('path_taken', `the file has since moved to ${head.path}`)
}

/**
 * Rows 20–21. The target version was resolved into the base fields by `commit.ts`.
 * A restore names the version it wants outright, so an unknown one is nothing to
 * restore rather than a head that changed.
 */
function decideRestore(op: Extract<CommitOp, { op: 'restore' }>, head: HeadState | null): Decision {
  if (head === null) return reject('not_found', 'no such file')
  if (head.baseIsKnown !== 'yes') return reject('not_found', 'that is not a version of this file')
  if (head.baseSha === null) return reject('invalid_request', 'that version has no content')
  // The file already shows that version: a restore of the head writes nothing.
  if (!head.deleted && head.versionId === op.version_id) return { kind: 'noop', status: 'applied' }
  return apply('restore', head.path, {
    sha: head.baseSha,
    size: head.baseSize ?? 0,
    mtime: head.baseMtime ?? 0,
  })
}

/**
 * Rows 2–4 and 9–11: both sides changed the content. A note is merged or copied
 * aside as the vault's settings say; anything else goes to the newer mtime, and
 * when that is the head, the incoming bytes still become a version in history.
 */
function contentRace(op: ContentOp, head: HeadState, settings: VaultSettings): Decision {
  if (head.kind === 'note') {
    // Merged in from this very base already: the head holds all of it that it ever will.
    // An old version's bytes alone are no such thing — sent from a base, they may be a revert.
    if (head.incoming === 'merged') return { kind: 'head-wins', status: 'merged' }
    return settings.conflict === 'merge'
      ? { kind: 'merge', path: head.path, status: 'merged' }
      : { kind: 'conflict-file', status: 'conflict' }
  }
  if (op.mtime > head.mtime) return apply('modify', head.path, op)
  // The loser is kept in history (§6) — unless it is the head's own bytes, or bytes a version
  // of the file already holds: either way nothing is lost, and nothing is written again.
  if (op.sha === head.sha || (head.incoming ?? null) !== null)
    return { kind: 'head-wins', status: 'merged' }
  return { kind: 'head-newer', status: 'merged' }
}

const notFound = (fileId: string): Decision => reject('not_found', `no file ${fileId}`)

/** Row 22: the base is a version the vault has, of some other file. Only that is the client's error. */
const otherFilesBase = (): Decision =>
  reject('invalid_request', 'base_version_id is not a version of this file')
