import { normalisePath } from '@abele/sync-protocol'
import type { FileInfo, FileSystem, PathMatcher } from '@abele/sync-core'

/** How many files are asked whether they have settled at once. */
const POOL = 16
/** How many may be asked at all in one listing; the rest wait for the next one. */
const MAX_ASKED = 64

/** What this needs of the disk: a filesystem that can also say whether a file has settled. */
export interface SettleableFileSystem extends FileSystem {
  /** Whether the file looks finished: two stats a moment apart that agree. */
  sizeStable(path: string): Promise<boolean>
}

/**
 * The vault, with a file that is still being written left for the next round.
 *
 * A person dropping a two-gigabyte video into the vault, or a program writing a file in
 * place rather than through a temp name, leaves the daemon looking at a file that will be
 * something else a second later. Uploading it then is not wrong — the next scan sends the
 * rest — but it is a whole version of a half a file in the vault's history, and on a slow
 * copy it is one every time the scanner comes round.
 *
 * So: every listing remembers what each file's size was, and a file whose size has moved
 * since the last one is asked whether it has settled — two stats a moment apart, which is
 * `sizeStable` on the adapter below. One that has not is named by `ignores`, which the
 * engine puts beside its own `isExcluded` in the scan filter: the scan sees the file, walks
 * past it and leaves the state entry it already had alone, so nothing is uploaded and
 * nothing is taken for deleted. The round after the copy finishes picks it up.
 *
 * A file is never asked about the first time it is seen. A first scan of a whole vault is
 * every file at once, and 200 ms each is a morning; a file being copied in right then is
 * uploaded as it stands and settled by the scan after it.
 *
 * The asking costs a fifth of a second whatever else it is doing, so it is done for the whole
 * listing at once rather than file by file: `POOL` at a time, and at most `MAX_ASKED` in one
 * round. Fifty files changed together — a folder dropped into the vault, a plugin rewriting its
 * settings — then costs one round of waiting rather than fifty. Past the cap the rest are simply
 * taken as still moving: the listing recorded where they had got to, so the next round asks
 * about them only if they have moved again, and takes them in if the copy has finished. That
 * errs towards syncing a file a round late rather than towards a scan that takes minutes.
 */
export class SettlingFileSystem implements FileSystem, PathMatcher {
  /** On-disk path → the size the last listing left it at. */
  private readonly sizes = new Map<string, number>()
  /** Wire paths that were still moving when they were last looked at. */
  private readonly growing = new Set<string>()
  /** Present only when the adapter watches, so the engine's `fs.watch !== undefined` is honest. */
  readonly watch?: (cb: (paths: string[]) => void) => () => void

  constructor(private readonly disk: SettleableFileSystem) {
    const watch = disk.watch
    if (watch) this.watch = (cb) => watch.call(disk, cb)
  }

  /**
   * The whole listing, with everything that moved asked about before any of it is handed over.
   *
   * The listing is read to the end first because the scanner tests `ignores` as each file
   * arrives: a verdict reached after the file was yielded would come a round too late. What it
   * holds is one `FileInfo` per file, which is what the scan builds for itself anyway.
   */
  async *list(): AsyncIterable<FileInfo> {
    const infos: FileInfo[] = []
    for await (const info of this.disk.list()) infos.push(info)
    await this.settle(infos)
    yield* infos
  }

  /** True while the file at this wire path is still being written. */
  ignores(wirePath: string): boolean {
    return this.growing.has(wirePath)
  }

  /** Sorts the listing into what has moved and what has not, and asks about the movers. */
  private async settle(infos: readonly FileInfo[]): Promise<void> {
    const seen = new Set<string>()
    const seenWire = new Set<string>()
    const moved: Array<{ info: FileInfo; wirePath: string }> = []
    for (const info of infos) {
      const wirePath = wireOf(info.path)
      seen.add(info.path)
      seenWire.add(wirePath)
      const before = this.sizes.get(info.path)
      this.sizes.set(info.path, info.size)
      if (before === undefined || before === info.size) {
        this.growing.delete(wirePath)
        continue
      }
      moved.push({ info, wirePath })
    }

    // Past the cap nothing is asked: those files are taken as still moving, and the round
    // after this one — where they will be among the first — decides properly.
    for (const { wirePath } of moved.slice(MAX_ASKED)) this.growing.add(wirePath)
    await inPool(moved.slice(0, MAX_ASKED), POOL, ({ info, wirePath }) => this.ask(info, wirePath))

    for (const path of [...this.sizes.keys()]) if (!seen.has(path)) this.sizes.delete(path)
    for (const wirePath of [...this.growing]) {
      if (!seenWire.has(wirePath)) this.growing.delete(wirePath)
    }
  }

  /** Whether this one file has finished being written, and what to remember either way. */
  private async ask(info: FileInfo, wirePath: string): Promise<void> {
    if (await this.disk.sizeStable(info.path)) {
      this.growing.delete(wirePath)
      return
    }
    this.growing.add(wirePath)
    // It moved again while we watched: the next listing compares against where it is now,
    // not against the size this one happened to catch it at.
    const now = await this.disk.stat(info.path)
    if (now) this.sizes.set(info.path, now.size)
  }

  /* ── Everything else is the disk's own ───────────────────────────────── */

  read(path: string): Promise<Uint8Array> {
    return this.disk.read(path)
  }

  writeAtomic(path: string, bytes: Uint8Array, mtime: number): Promise<void> {
    return this.disk.writeAtomic(path, bytes, mtime)
  }

  move(from: string, to: string): Promise<void> {
    return this.disk.move(from, to)
  }

  remove(path: string): Promise<void> {
    return this.disk.remove(path)
  }

  stat(path: string): Promise<FileInfo | null> {
    return this.disk.stat(path)
  }
}

/** Runs the work over the items, `width` of them at a time, in the order they were given. */
async function inPool<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!
      next++
      await work(item)
    }
  })
  await Promise.all(runners)
}

/** Every matcher as one: a path any of them names is a path the engine passes over. */
export function anyOf(matchers: readonly PathMatcher[]): PathMatcher {
  return { ignores: (wirePath) => matchers.some((matcher) => matcher.ignores(wirePath)) }
}

/** The wire spelling of an on-disk path, or its own when the wire would not have it. */
function wireOf(path: string): string {
  try {
    return normalisePath(path)
  } catch {
    return path
  }
}
