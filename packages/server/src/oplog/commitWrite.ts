import { caseKey, nextFreeName, type CommitOpResult } from '@abele/sync-protocol'
import { sql } from 'kysely'
import { forgetUpload } from '../blobs/pending.js'
import { addRef } from '../blobs/refs.js'
import { writeJson } from '../db/json.js'
import { bumpUsage } from '../history/usage.js'
import { retentionClass } from '../history/retentionClass.js'
import { recordVersionSecurity } from '../scoped/versionSecurity.js'
import { recordFolderVersion } from '../scoped/admissions.js'
import { newId } from '../ids.js'
import { conflictCopyName, frontmatterIsValid, mergeText } from '../merge/index.js'
import {
  corrupt,
  mergeBase,
  requireSha,
  type ContentOp,
  type Ctx,
  type LoadedHead,
  type NewVersion,
} from './commitCtx.js'
import { liveBytes, storedBlob, takenPredicate } from './commitHead.js'
import { fileKind } from './kinds.js'
import type { Decision } from './resolve.js'

/**
 * A decision carried out (see `commit.ts`): the versions it writes, the file row pointed at the
 * new head, and the result the device is answered with.
 */

/* ── Carrying decisions out ────────────────────────────────────────────── */

/** Write the version the decision describes and point the file at it. */
export async function applyOp(
  ctx: Ctx,
  head: LoadedHead | null,
  decision: Extract<Decision, { kind: 'apply' }>,
  inputSourceVersionId?: string
): Promise<CommitOpResult> {
  // A file coming back from the trash takes the next free name if its own is gone.
  const path = head?.deleted
    ? ctx.restoreDestination
      ? await ctx.restoreDestination(decision.path)
      : nextFreeName(decision.path, await takenPredicate(ctx, decision.path))
    : decision.path
  const fileId = head?.fileId ?? newId()
  const { versionId, seq } = await writeVersion(ctx, head, {
    fileId,
    op: decision.op,
    path,
    prevPath: decision.op === 'move' && head !== null ? head.path : null,
    sha: decision.sha,
    size: decision.size,
    mtime: decision.mtime,
    no: (head?.no ?? 0) + 1,
    prevVersionId: head?.versionId ?? null,
    merge: null,
    // Direct application still depends on the incoming edit's actual base (or restore
    // source), which can differ from the current head used by prevVersionId.
    securitySourceVersionIds: inputSourceVersionId === undefined ? [] : [inputSourceVersionId],
  })
  await pointFile(ctx, head, fileId, versionId, path, decision.op === 'delete')
  return {
    status: 'applied',
    file_id: fileId,
    version_id: versionId,
    seq,
    path,
    sha: decision.sha,
    size: decision.size,
    mtime: decision.mtime,
  }
}

/**
 * Three-way merge of a note: the base the device edited from (nothing, for a
 * create, or for a base the vault no longer has), the head it did not see, and
 * what it sent. A merge that breaks the frontmatter is not written; the bytes go
 * to a conflict copy instead.
 *
 * When the merge is not exactly what was sent, the sent text is first written as
 * a version of its own, as a losing binary is (`keepLoser`), and the merge after
 * it. The sender's text is then restorable as itself, and a device that cannot
 * take the merged head (over its size cap) has a version its disk really holds to
 * record its copy against: a create has no base of its own, and a copy recorded
 * against any other version reads, at its next edit, as deleting what that
 * version holds and the copy does not.
 */
export async function mergeOp(ctx: Ctx, op: ContentOp, head: LoadedHead): Promise<CommitOpResult> {
  const baseSha = op.op === 'modify' ? head.baseSha : null
  const base = baseSha === null ? '' : (await storedBlob(ctx, baseSha, 'base')).toString('utf8')
  const current = (await storedBlob(ctx, requireSha(head), 'head')).toString('utf8')
  const incoming = await ctx.store.get(op.sha)
  const merged = mergeText(base, current, incoming.toString('utf8'))
  if (merged.conflictCopy || !frontmatterIsValid(merged.text)) return keepBothSides(ctx, op, head)

  const bytes = Buffer.from(merged.text, 'utf8')
  // The limits were checked against what was sent; a merge is bytes nobody sent.
  if (await overLimits(ctx, head, bytes.length)) return keepBothSides(ctx, op, head)
  const { sha, size } = await ctx.store.put(bytes)
  const mtime = ctx.at.getTime()
  const before = bytes.equals(incoming) ? head : await keepIncoming(ctx, op, head)
  const { versionId, seq } = await writeVersion(ctx, before, {
    fileId: head.fileId,
    op: 'merge',
    path: head.path,
    prevPath: null,
    sha,
    size,
    mtime,
    no: before.no + 1,
    prevVersionId: before.versionId,
    merge: {
      // The base the merge really ran from: none, when the vault no longer had it.
      base_version_id: mergeBase(op, head.baseIsKnown),
      head_version_id: head.versionId,
      incoming_sha: op.sha,
      clean: merged.clean,
    },
    securitySourceVersionIds: op.op === 'modify' ? [op.base_version_id] : [],
  })
  await pointFile(ctx, head, head.fileId, versionId, head.path, false)

  const ids = { file_id: head.fileId, version_id: versionId, seq, path: head.path }
  // The merge landed exactly on what the device sent: it already has the result.
  if (bytes.equals(incoming)) return { status: 'applied', ...ids, sha, size, mtime }
  return { status: 'merged', ...ids, sha, size, mtime }
}

/**
 * Whether a merged head of `size` bytes in place of `head` would break the file limit or the
 * vault's quota. The incoming bytes passed both on their own (`checkLimits`), but a merge holds
 * both sides' edits and can be larger than either.
 */
async function overLimits(ctx: Ctx, head: LoadedHead, size: number): Promise<boolean> {
  const { max_file_bytes, quota_bytes } = ctx.settings
  if (size > max_file_bytes) return true
  if (quota_bytes === null) return false
  const replaced = head.deleted ? 0 : head.size
  return (await liveBytes(ctx)) + size - replaced > quota_bytes
}

/**
 * Both sides kept, where a merge is too large to write, breaks the frontmatter, or the vault
 * copies conflicts aside: neither side is lost and nothing over a limit is written. The
 * head stays where it is, and the incoming text goes into a conflict copy beside it — a file
 * the user sees — provided the copy fits the quota: it is within the file limit, since the
 * incoming bytes passed it. When it does not fit (and a merge over the quota usually means a
 * copy is over it too, a copy being all of the incoming text beside all of the head), the
 * incoming text is kept as a version in the file's history, under the head, as a losing binary
 * is (`keepLoser`): nothing new is live, and *Version history* brings it back.
 */
export async function keepBothSides(
  ctx: Ctx,
  op: ContentOp,
  head: LoadedHead
): Promise<CommitOpResult> {
  const { quota_bytes } = ctx.settings
  const copyFits = quota_bytes === null || (await liveBytes(ctx)) + op.size <= quota_bytes
  return copyFits ? conflictCopyOp(ctx, op, head) : keepLoser(ctx, op, head)
}

/**
 * Keep the head and put the incoming bytes in a conflict copy beside it. Only through
 * `keepBothSides`: the limits were checked with the incoming bytes in place of the head, and a
 * copy puts them beside it instead, so whether the copy fits the quota is asked there. The
 * result carries the head's bytes as well, so a device that never pulled the
 * head can put it at the path without waiting for the feed.
 */
async function conflictCopyOp(ctx: Ctx, op: ContentOp, head: LoadedHead): Promise<CommitOpResult> {
  const wanted = conflictCopyName(head.path, ctx.actor.name, ctx.at)
  const path = ctx.conflictDestination
    ? await ctx.conflictDestination(wanted)
    : nextFreeName(wanted, await takenPredicate(ctx, wanted))
  if (path === null) return keepLoser(ctx, op, head)
  const fileId = newId()
  const { versionId } = await writeVersion(ctx, null, {
    fileId,
    op: 'conflict',
    path,
    securitySourceVersionIds: [head.versionId, ...(op.op === 'modify' ? [op.base_version_id] : [])],
    prevPath: null,
    sha: op.sha,
    size: op.size,
    mtime: op.mtime,
    no: 1,
    prevVersionId: null,
    merge: null,
  })
  await pointFile(ctx, null, fileId, versionId, path, false)
  return {
    status: 'conflict',
    file_id: head.fileId,
    version_id: head.versionId,
    seq: head.seq,
    path: head.path,
    sha: requireSha(head),
    size: head.size,
    mtime: head.mtime,
    conflict_path: path,
    conflict_file_id: fileId,
    conflict_version_id: versionId,
  }
}

/**
 * Opaque bytes that lost to a newer head (§6): they are not thrown away but
 * written as a version of the file, so *Version history* can bring them back,
 * and the head is written once more after them, so it is still what the file
 * holds and what every device's feed ends on. The device that sent the loser is
 * handed that re-written head, which it fetches as it would any merge.
 */
export async function keepLoser(
  ctx: Ctx,
  op: ContentOp,
  head: LoadedHead
): Promise<CommitOpResult> {
  const sha = requireSha(head)
  const between = await keepIncoming(ctx, op, head)
  const { versionId, seq } = await writeVersion(ctx, between, {
    fileId: head.fileId,
    op: 'merge',
    path: head.path,
    prevPath: null,
    sha,
    size: head.size,
    mtime: head.mtime,
    no: between.no + 1,
    prevVersionId: between.versionId,
    merge: {
      base_version_id: mergeBase(op, head.baseIsKnown),
      head_version_id: head.versionId,
      incoming_sha: op.sha,
      // Nothing of the incoming bytes is in the result: a pick, not a merge.
      clean: false,
    },
    securitySourceVersionIds: op.op === 'modify' ? [op.base_version_id] : [],
  })
  await pointFile(ctx, head, head.fileId, versionId, head.path, false)
  return {
    status: 'merged',
    file_id: head.fileId,
    version_id: versionId,
    seq,
    path: head.path,
    sha,
    size: head.size,
    mtime: head.mtime,
  }
}

/**
 * The op's own bytes written as a version on top of the head, for a merge or a pick to be
 * written after. Returns what the file held for that one seq, as `writeVersion` counts the
 * next row against it.
 */
async function keepIncoming(ctx: Ctx, op: ContentOp, head: LoadedHead): Promise<LoadedHead> {
  const kept = await writeVersion(ctx, head, {
    fileId: head.fileId,
    op: 'modify',
    path: head.path,
    prevPath: null,
    sha: op.sha,
    size: op.size,
    mtime: op.mtime,
    no: head.no + 1,
    prevVersionId: head.versionId,
    merge: null,
    securitySourceVersionIds: op.op === 'modify' ? [op.base_version_id] : [],
  })
  return {
    ...head,
    deleted: false,
    versionId: kept.versionId,
    seq: kept.seq,
    sha: op.sha,
    size: op.size,
    mtime: op.mtime,
    no: head.no + 1,
  }
}

/** Nothing written: the device is told what the head is and fetches it. */
export function headWins(head: LoadedHead): CommitOpResult {
  return {
    status: 'merged',
    file_id: head.fileId,
    version_id: head.versionId,
    seq: head.seq,
    path: head.path,
    sha: requireSha(head),
    size: head.size,
    mtime: head.mtime,
  }
}

/** Nothing written: the file is already as the op wanted it, so the head is the result. */
export function applied(head: LoadedHead): CommitOpResult {
  return {
    status: 'applied',
    file_id: head.fileId,
    version_id: head.versionId,
    seq: head.seq,
    path: head.path,
    sha: head.sha,
    size: head.size,
    mtime: head.mtime,
  }
}

/* ── Rows ──────────────────────────────────────────────────────────────── */

/** Take the vault's next sequence number. Gap-free because the lock is held. */
async function nextSeq(ctx: Ctx): Promise<number> {
  const row = await ctx.trx
    .updateTable('vault_seq')
    .set({ head_seq: sql<number>`head_seq + 1` })
    .where('vault_id', '=', ctx.vaultId)
    .returning('head_seq')
    .executeTakeFirst()
  if (row === undefined) throw corrupt(`vault ${ctx.vaultId} has no sequence row`)
  return row.head_seq
}

/** Insert a version at the next seq, count its blob reference and its usage. */
async function writeVersion(
  ctx: Ctx,
  head: LoadedHead | null,
  v: NewVersion
): Promise<{ versionId: string; seq: number }> {
  const seq = await nextSeq(ctx)
  const versionId = newId()
  const at = ctx.at.toISOString()
  await ctx.trx
    .insertInto('versions')
    .values({
      id: versionId,
      file_id: v.fileId,
      vault_id: ctx.vaultId,
      seq,
      no: v.no,
      op: v.op,
      path: v.path,
      path_ci: caseKey(v.path),
      prev_path: v.prevPath,
      blob_sha: v.sha,
      size: v.size,
      mtime: v.mtime,
      actor_kind: ctx.actor.kind,
      actor_id: ctx.actor.id,
      actor_name: ctx.actor.name,
      created_at: at,
      prev_version_id: v.prevVersionId,
      merge: v.merge === null ? null : writeJson(v.merge),
      retention_class: retentionClass(fileKind(v.path, ctx.settings)),
    })
    .execute()
  await recordVersionSecurity(ctx, head, v, versionId)
  await ctx.authorizeOutput?.(v, versionId)
  await recordFolderVersion(ctx, v, versionId)
  if (v.sha !== null) {
    await addRef(ctx.trx, ctx.store, v.sha, v.size, at)
    if (!ctx.scopedWriter) await forgetUpload(ctx.trx, ctx.vaultId, v.sha)
  }

  const wasLive = head !== null && !head.deleted
  const isLive = v.op !== 'delete'
  await bumpUsage(ctx.trx, ctx.vaultId, at.slice(0, 10), {
    live: (isLive ? v.size : 0) - (wasLive ? head.size : 0),
    history: wasLive ? head.size : 0,
    trash: 0,
    kind: fileKind(v.path, ctx.settings),
    countDelta: (isLive ? 1 : 0) - (wasLive ? 1 : 0),
  })
  return { versionId, seq }
}

/** Make the file row point at its new head, at its (possibly new) path, live or deleted. */
async function pointFile(
  ctx: Ctx,
  head: LoadedHead | null,
  fileId: string,
  versionId: string,
  path: string,
  deleted: boolean
): Promise<void> {
  const columns = {
    path,
    path_ci: caseKey(path),
    kind: fileKind(path, ctx.settings),
    head_version_id: versionId,
    deleted_at: deleted ? ctx.at.toISOString() : null,
  }
  if (head === null) {
    await ctx.trx
      .insertInto('files')
      .values({ id: fileId, vault_id: ctx.vaultId, ...columns })
      .execute()
    return
  }
  await ctx.trx.updateTable('files').set(columns).where('id', '=', fileId).execute()
}
