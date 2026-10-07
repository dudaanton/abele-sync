import type { ChangeItem } from '@abele/sync-protocol'
import type { StateEntry, StateStore } from './state.js'

/**
 * Staged changes: the server's changes to files a host would rather
 * not have written under it while it runs — Obsidian's own settings, which it reads at launch
 * and writes back from memory — kept until the host says when.
 *
 * A staged change is not written and not held. The cursor moves past it, the file's entry keeps
 * the version it had, and so the scan finds nothing to push for it. Each file has at most one:
 * the latest change the pulls brought, whatever its op, replaces the one before.
 *
 * What becomes of one:
 * - the host applies it (`SyncEngine.applyDeferred`): written as a pull would have, unless the
 *   file changed here since, which is then this device's edit to push like any other;
 * - the host keeps this device's (`SyncEngine.keepLocal`): for a file this disk has, the entry
 *   is moved to the server's version, so the next scan sends this disk's bytes as a change on
 *   the head; a file only the other side has is left alone there and stays absent here. Keeping
 *   never deletes anything on another device;
 * - either answer may name the versions the host showed: then only a record still at one of
 *   them is written or kept, and one replaced since — or never shown — stays staged and is
 *   handed back, so the host asks about it rather than act on what nobody saw;
 * - a commit of this device's lands for the file first: the edit made here went out over it,
 *   and the server settled the two. The record goes; the file is what the commit left.
 * - the file leaves this device's scope: the record goes, and the scope marks bring the file
 *   back through a manifest walk if the scope widens again, staged afresh.
 *
 * The records are filed in the state's meta, through the engine's guarded store, so a restart
 * finds them, and a host whose claim on the vault lapsed files none. A store without meta keeps
 * them in memory for as long as the engine lives.
 */

/** The shared placement gate: destination, source and any locally recorded spelling count. */
export function touchesDeferred(
  defer: ((wirePath: string) => boolean) | undefined,
  ...paths: Array<string | null | undefined>
): boolean {
  return defer !== undefined && paths.some((path) => path != null && defer(path))
}

/** An excluded destination still removes a locally recorded source that the host defers. */
export function deferredSource(
  defer: ((wirePath: string) => boolean) | undefined,
  change: ChangeItem,
  entry: StateEntry | null
): boolean {
  return entry !== null && entry.wirePath !== change.path && touchesDeferred(defer, entry.wirePath)
}

/** Where the staged changes are filed. */
export const DEFERRED_KEY = 'deferred-changes'

/** One staged change, and the version its file's entry had when it was staged. */
export interface Staged {
  change: ChangeItem
  /**
   * The entry's version when the change was staged, or null when there was no entry. The pulls
   * never move an entry whose change is staged, so an entry at another version later means a
   * push of this device's landed for that file — the edit here went out over the change.
   */
  base: string | null
  /** A local outcome already settled by a push; do not resend it while approval is pending. */
  settled?: { path: string; sha: string | null }
}

/** Preserve the local source even when the feed collapsed a move into a later modify. */
export function stageFrom(change: ChangeItem, entry: StateEntry | null): Staged {
  return {
    change:
      entry !== null && entry.wirePath !== change.path
        ? { ...change, prev_path: entry.wirePath }
        : change,
    base: entry?.versionId ?? null,
  }
}

interface Filed {
  staged: Staged[]
}

/**
 * The records as filed. An older build also filed `keptDeletes` — deletes it let past the
 * delete guard — and those are read as nothing: such a delete, if the scan still finds it, is
 * then judged by the guard like any other.
 */
function parse(raw: string | null): Filed {
  if (raw === null) return { staged: [] }
  try {
    const value = JSON.parse(raw) as Partial<Filed> | null
    if (value === null || typeof value !== 'object') return { staged: [] }
    const staged = Array.isArray(value.staged)
      ? value.staged.filter(
          (one): one is Staged =>
            typeof one === 'object' &&
            one !== null &&
            typeof one.change === 'object' &&
            one.change !== null &&
            typeof one.change.file_id === 'string' &&
            typeof one.change.path === 'string' &&
            (one.base === null || typeof one.base === 'string')
        )
      : []
    return { staged }
  } catch {
    return { staged: [] }
  }
}

/** The staged changes as the state holds them, oldest seq first; none for a store without meta. */
export async function readStaged(state: StateStore): Promise<ChangeItem[]> {
  const filed = parse(state.getMeta ? await state.getMeta(DEFERRED_KEY) : null)
  return filed.staged.map((one) => one.change).sort((a, b) => a.seq - b.seq)
}

/**
 * The engine's staged changes, read once per engine and written through on every change.
 * Only the engine's own run queue writes them, so the copy here is never behind the state.
 */
export class StagedChanges {
  private filed: Filed | null = null

  constructor(private readonly state: StateStore) {}

  private async load(): Promise<Filed> {
    if (this.filed === null) {
      this.filed = parse(this.state.getMeta ? await this.state.getMeta(DEFERRED_KEY) : null)
    }
    return this.filed
  }

  private async save(next: Filed): Promise<void> {
    if (this.state.setMeta) {
      await this.state.setMeta(
        DEFERRED_KEY,
        next.staged.length === 0 ? null : JSON.stringify({ staged: next.staged })
      )
    }
    this.filed = next
  }

  /** Every staged change with its base, oldest seq first. */
  async list(): Promise<Staged[]> {
    const { staged } = await this.load()
    return [...staged].sort((a, b) => a.change.seq - b.change.seq)
  }

  async count(): Promise<number> {
    return (await this.load()).staged.length
  }

  /**
   * Stage these, each replacing whatever was staged for its file. The number that are news: a
   * change already staged, as a rewound walk brings it again, is not, and neither is a later
   * version of the same bytes at the same path — the head a push was answered with, re-written
   * over the loser it kept, which the next pull brings as a change of its own.
   *
   * The same version staged again keeps the change it was first staged with: a pull meeting the
   * head a push staged names the device that sent the loser, where the push named the device
   * whose head it was.
   */
  async stage(items: Staged[]): Promise<number> {
    if (items.length === 0) return 0
    const filed = await this.load()
    const byId = new Map(filed.staged.map((one) => [one.change.file_id, one]))
    let fresh = 0
    for (const item of items) {
      const before = byId.get(item.change.file_id)
      if (before !== undefined && before.change.version_id === item.change.version_id) {
        byId.set(item.change.file_id, { ...before, ...item, change: before.change })
        continue
      }
      const same =
        before !== undefined &&
        before.change.sha !== null &&
        before.change.sha === item.change.sha &&
        before.change.path === item.change.path
      if (!same) fresh++
      byId.set(item.change.file_id, {
        ...item,
        ...(item.settled === undefined && before?.settled !== undefined
          ? { settled: before.settled }
          : {}),
      })
    }
    await this.save({ ...filed, staged: [...byId.values()] })
    return fresh
  }

  /** Forget the staged changes of these files. */
  async drop(fileIds: Iterable<string>): Promise<void> {
    const gone = new Set(fileIds)
    if (gone.size === 0) return
    const filed = await this.load()
    const staged = filed.staged.filter((one) => !gone.has(one.change.file_id))
    if (staged.length === filed.staged.length) return
    await this.save({ ...filed, staged })
  }
}
