import { existsSync, watch as watchDir } from 'node:fs'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineError, encodeText, type FileInfo } from '@abele/sync-core'
import { normalisePath } from '@abele/sync-protocol'
import { NodeFileSystem } from '../../src/nodeFs.js'

/**
 * The listener each `fs.watch` was handed, newest last. The watcher stays real; this is so the
 * batching tests can speak for the disk and drive the debounce on a fake clock, which a busy
 * machine cannot push around the way it pushes around a real one.
 */
const watchHooks = vi.hoisted(() => ({
  listeners: [] as Array<(event: string, name: string | null) => void>,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const watch = ((...args: unknown[]) => {
    const listener = args.find((arg) => typeof arg === 'function')
    if (listener) watchHooks.listeners.push(listener as (typeof watchHooks.listeners)[number])
    return (actual.watch as (...a: unknown[]) => ReturnType<typeof actual.watch>)(...args)
  }) as typeof actual.watch
  return { ...actual, default: { ...actual, watch }, watch }
})

/** Tells the newest watcher that the disk changed `name`, as the platform would. */
function emit(name: string): void {
  const listener = watchHooks.listeners.at(-1)
  if (!listener) throw new Error('no watcher is listening')
  listener('rename', name)
}

/** The watcher's debounce and ceiling, as `nodeFs.ts` sets them. */
const DEBOUNCE_MS = 300
const MAX_WAIT_MS = 2000

/** Only the clock the batching reads; I/O and `setImmediate` stay real. */
const FAKE_CLOCK: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'Date'],
}

/** Lets real I/O and promise chains run until `done` holds; the test timeout is the bound. */
async function settle(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((r) => setImmediate(r))
}

const bytes = (s: string) => encodeText(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const readFileText = (absolute: string): Promise<string> => readFile(absolute, 'utf8')

/** Does this platform watch a whole tree at once? Decided once, so a skip can say why. */
const RECURSIVE_WATCH = (() => {
  try {
    watchDir(tmpdir(), { recursive: true }).close()
    return true
  } catch {
    return false
  }
})()

let root: string

/** Whether the disk under `root` folds case, which decides what a case-only rename has to do. */
async function foldsCase(): Promise<boolean> {
  await writeFile(join(root, 'CaseProbe.tmp'), 'x')
  try {
    await stat(join(root, 'caseprobe.tmp'))
    return true
  } catch {
    return false
  } finally {
    await rm(join(root, 'CaseProbe.tmp'), { force: true })
  }
}

/** Waits for the watcher to have reported what the test is after, or gives up and lets it fail. */
async function waitFor(done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
}

async function collect(fs: NodeFileSystem): Promise<FileInfo[]> {
  const found: FileInfo[] = []
  for await (const info of fs.list()) found.push(info)
  return found.sort((a, b) => a.path.localeCompare(b.path))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'abele-nodefs-'))
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

describe('NodeFileSystem', () => {
  it('reads back what writeAtomic wrote, with its size and mtime', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('notes/a.md', bytes('hello'), 1000)
    expect(text(await fs.read('notes/a.md'))).toBe('hello')
    expect(await fs.stat('notes/a.md')).toEqual({ path: 'notes/a.md', size: 5, mtime: 1000 })
  })

  it('creates parent directories and lists files under their relative paths', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('deep/nested/dir/a.md', bytes('a'), 1000)
    await fs.writeAtomic('b.md', bytes('bb'), 2000)
    expect(await collect(fs)).toEqual([
      { path: 'b.md', size: 2, mtime: 2000 },
      { path: 'deep/nested/dir/a.md', size: 1, mtime: 1000 },
    ])
  })

  it('replaces the content and mtime of an existing path', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', bytes('one'), 1000)
    await fs.writeAtomic('a.md', bytes('second'), 2000)
    expect(text(await fs.read('a.md'))).toBe('second')
    expect(await fs.stat('a.md')).toEqual({ path: 'a.md', size: 6, mtime: 2000 })
    expect(await collect(fs)).toHaveLength(1)
  })

  it('leaves no temp file behind and never exposes a partial write', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', bytes('body'), 3000)
    expect(await readdir(join(root, '.abele-sync', 'tmp'))).toEqual([])
    expect(await collect(fs)).toEqual([{ path: 'a.md', size: 4, mtime: 3000 }])
  })

  it('sets the mtime the caller asked for and leaves the atime alone', async () => {
    const fs = new NodeFileSystem(root)
    const before = Date.now()
    await fs.writeAtomic('a.md', bytes('body'), 3000)
    const stats = await stat(join(root, 'a.md'))
    expect(stats.mtimeMs).toBe(3000)
    // The file was written moments ago; only its mtime is the engine's to say.
    expect(stats.atimeMs).toBeGreaterThanOrEqual(before - 1000)
  })

  it('clears what a killed process left in the temp folder only when asked, folders included', async () => {
    const temp = join(root, '.abele-sync', 'tmp')
    await mkdir(join(temp, 'leftover', 'deeper'), { recursive: true })
    await writeFile(join(temp, 'half-written'), 'x')
    await writeFile(join(temp, 'leftover', 'deeper', 'buried'), 'x')
    await writeFile(join(root, 'kept.md'), 'kept')
    // Opening the disk sweeps nothing: a `status` beside a running daemon opens one too.
    const fs = new NodeFileSystem(root)
    expect((await readdir(temp)).sort()).toEqual(['half-written', 'leftover'])
    fs.sweepTemp()
    expect(await readdir(temp)).toEqual([])
    // Only what the temp folder held: the vault beside it is untouched.
    expect((await readdir(root)).sort()).toEqual(['.abele-sync', 'kept.md'])
    fs.removeTemp()
    expect(existsSync(temp)).toBe(false)
    // And with nothing there, neither is an error.
    fs.sweepTemp()
    fs.removeTemp()
  })

  it('skips symlinks, directories and the engine-owned folder when listing', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('notes/a.md', bytes('a'), 1000)
    await mkdir(join(root, 'empty'), { recursive: true })
    await symlink(join(root, 'notes/a.md'), join(root, 'link.md'))
    await mkdir(join(root, '.abele-sync'), { recursive: true })
    await writeFile(join(root, '.abele-sync', 'state.db'), 'x')
    expect(await collect(fs)).toEqual([{ path: 'notes/a.md', size: 1, mtime: 1000 }])
  })

  it('skips every configured ignore folder, and only at the root', async () => {
    const fs = new NodeFileSystem(root, { ignoreDirs: ['.abele-sync', '.trash'] })
    await fs.writeAtomic('.trash/gone.md', bytes('gone'), 1000)
    await fs.writeAtomic('notes/.trash/kept.md', bytes('kept'), 1000)
    expect(await collect(fs)).toEqual([{ path: 'notes/.trash/kept.md', size: 4, mtime: 1000 }])
  })

  it('hides the state folder whatever ignoreDirs says', async () => {
    const fs = new NodeFileSystem(root, { ignoreDirs: ['.trash'] })
    await mkdir(join(root, '.abele-sync'), { recursive: true })
    await writeFile(join(root, '.abele-sync', 'config.json'), '{"deviceToken":"secret"}')
    await fs.writeAtomic('.trash/gone.md', bytes('gone'), 1000)
    await fs.writeAtomic('kept.md', bytes('kept'), 1000)
    expect(await collect(fs)).toEqual([{ path: 'kept.md', size: 4, mtime: 1000 }])
  })

  it('with skipHidden, never descends into a hidden folder other than the root .obsidian', async () => {
    const fs = new NodeFileSystem(root, { skipHidden: true })
    for (const path of [
      '.git/HEAD',
      '.git/objects/ab/cdef',
      'Sub/.cache/blob',
      'Sub/.obsidian/app.json',
      '.obsidian/app.json',
      '.obsidian/plugins/p/main.js',
      '.DS_Store',
      'note.md',
    ]) {
      await fs.writeAtomic(path, bytes('x'), 1000)
    }
    // A hidden file is still listed — the filter says what becomes of it; a folder is not walked.
    expect((await collect(fs)).map((info) => info.path)).toEqual([
      '.DS_Store',
      '.obsidian/app.json',
      '.obsidian/plugins/p/main.js',
      'note.md',
    ])
    // Without the option everything is walked, as before.
    expect(await collect(new NodeFileSystem(root))).toHaveLength(8)
  })

  it('lists a decomposed name as the disk spells it, for normalisePath to fold', async () => {
    const fs = new NodeFileSystem(root)
    const nfd = 'cafe\u0301.md'
    expect(nfd).not.toBe(nfd.normalize('NFC'))
    await writeFile(join(root, nfd), 'x')
    const listed = await collect(fs)
    expect(listed.map((f) => f.path)).toEqual([nfd])
    expect(normalisePath(listed[0]!.path)).toBe('caf\u00e9.md')
  })

  it('refuses every path that leads out of the vault, whatever the separator', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', bytes('a'), 1000)
    const escapes = ['..\\escape.md', 'a/../../escape.md', '../escape.md', '/etc/hosts', '', '.']
    for (const bad of escapes) {
      await expect(fs.read(bad)).rejects.toMatchObject({ code: 'io' })
      await expect(fs.writeAtomic(bad, bytes('x'), 1000)).rejects.toMatchObject({ code: 'io' })
      await expect(fs.move('a.md', bad)).rejects.toMatchObject({ code: 'io' })
      await expect(fs.move(bad, 'b.md')).rejects.toMatchObject({ code: 'io' })
      await expect(fs.remove(bad)).rejects.toMatchObject({ code: 'io' })
      await expect(fs.stat(bad)).rejects.toMatchObject({ code: 'io' })
    }
    expect(existsSync(join(root, '..', 'escape.md'))).toBe(false)
    expect(await collect(fs)).toEqual([{ path: 'a.md', size: 1, mtime: 1000 }])
  })

  it('throws an io EngineError when reading a missing path', async () => {
    const fs = new NodeFileSystem(root)
    await expect(fs.read('nope.md')).rejects.toThrow(EngineError)
    await expect(fs.read('nope.md')).rejects.toMatchObject({ code: 'io' })
  })

  it('stats a missing path, a directory and a symlink as null', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', bytes('a'), 1000)
    await mkdir(join(root, 'dir'))
    await symlink(join(root, 'a.md'), join(root, 'link.md'))
    expect(await fs.stat('nope.md')).toBeNull()
    expect(await fs.stat('dir')).toBeNull()
    expect(await fs.stat('link.md')).toBeNull()
  })

  it('moves a file into a folder that does not exist yet, keeping its bytes and mtime', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('from.md', bytes('body'), 7000)
    await fs.move('from.md', 'sub/deep/to.md')
    expect(await fs.stat('from.md')).toBeNull()
    expect(text(await fs.read('sub/deep/to.md'))).toBe('body')
    expect(await fs.stat('sub/deep/to.md')).toEqual({
      path: 'sub/deep/to.md',
      size: 4,
      mtime: 7000,
    })
  })

  it('refuses to move onto an existing path and leaves both files alone', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('from.md', bytes('from'), 1000)
    await fs.writeAtomic('to.md', bytes('to'), 2000)
    await expect(fs.move('from.md', 'to.md')).rejects.toMatchObject({ code: 'io' })
    expect(text(await fs.read('from.md'))).toBe('from')
    expect(text(await fs.read('to.md'))).toBe('to')
  })

  it('refuses to move a missing path', async () => {
    const fs = new NodeFileSystem(root)
    await expect(fs.move('missing.md', 'to.md')).rejects.toMatchObject({ code: 'io' })
  })

  it('renames a file to another spelling of its own name', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('Note.md', bytes('body'), 1000)
    const folded = await foldsCase()
    await fs.move('Note.md', 'note.md')
    expect(text(await fs.read('note.md'))).toBe('body')
    const listed = await collect(fs)
    expect(listed.map((f) => f.path)).toEqual(['note.md'])
    expect(await readdir(join(root, '.abele-sync', 'tmp'))).toEqual([])
    // On a case-folding disk the old spelling still resolves; on any disk the name is the new one.
    if (folded) expect(await fs.stat('Note.md')).not.toBeNull()
    else expect(await fs.stat('Note.md')).toBeNull()
  })

  it('dates a file from before 1970 at the epoch', async () => {
    const fs = new NodeFileSystem(root)
    await writeFile(join(root, 'old.md'), 'old')
    await utimes(join(root, 'old.md'), -86400, -86400)
    // macOS will not set a time before the epoch and leaves the file dated now; only a
    // platform that does can show the clamp. The scanner clamps on its own side as well.
    if ((await stat(join(root, 'old.md'))).mtimeMs >= 0) return
    expect(await fs.stat('old.md')).toMatchObject({ mtime: 0 })
    expect((await collect(fs)).map((info) => info.mtime)).toEqual([0])
  })

  it('refuses, as a conflict, to write or remove where a folder or a link is', async () => {
    const fs = new NodeFileSystem(root)
    await mkdir(join(root, 'folder.md'))
    await writeFile(join(root, 'real.md'), 'real')
    await symlink(join(root, 'real.md'), join(root, 'link.md'))
    await expect(fs.writeAtomic('folder.md', bytes('x'), 1000)).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(fs.remove('folder.md')).rejects.toMatchObject({ code: 'conflict' })
    await expect(fs.writeAtomic('link.md', bytes('x'), 1000)).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(fs.remove('link.md')).rejects.toMatchObject({ code: 'conflict' })
    // A move onto either, or of either, is refused the same way.
    await expect(fs.move('real.md', 'folder.md')).rejects.toMatchObject({ code: 'conflict' })
    await expect(fs.move('real.md', 'link.md')).rejects.toMatchObject({ code: 'conflict' })
    await expect(fs.move('folder.md', 'moved.md')).rejects.toMatchObject({ code: 'conflict' })
    await expect(fs.move('link.md', 'moved.md')).rejects.toMatchObject({ code: 'conflict' })
    // Nothing was touched: the folder is still a folder, the link still a link, the file intact.
    expect((await stat(join(root, 'folder.md'))).isDirectory()).toBe(true)
    expect(await readFileText(join(root, 'real.md'))).toBe('real')
    expect(existsSync(join(root, 'moved.md'))).toBe(false)
    // A plain file at the target is still `io`: that is somebody's file, not something in the way.
    await writeFile(join(root, 'other.md'), 'other')
    await expect(fs.move('real.md', 'other.md')).rejects.toMatchObject({ code: 'io' })
  })

  it('touches nothing beneath a folder that is a link, wherever the link points', async () => {
    // A vault folder swapped for a link to somewhere else: the path string stays inside the
    // vault, but every operation through it would land outside. Each one is refused as a
    // conflict, so the engine holds the change and says so, and the outside is left alone.
    const outside = await mkdtemp(join(tmpdir(), 'abele-outside-'))
    try {
      await writeFile(join(outside, 'x.md'), 'outside')
      await writeFile(join(outside, 'y.md'), 'outside y')
      await mkdir(join(root, 'deep'))
      await symlink(outside, join(root, 'Notes'))
      await symlink(outside, join(root, 'deep', 'Inner'))
      const fs = new NodeFileSystem(root)
      await writeFile(join(root, 'real.md'), 'real')
      for (const base of ['Notes', 'deep/Inner']) {
        await expect(fs.writeAtomic(`${base}/x.md`, bytes('pwned'), 1000)).rejects.toMatchObject({
          code: 'conflict',
        })
        await expect(fs.writeAtomic(`${base}/new/z.md`, bytes('z'), 1000)).rejects.toMatchObject({
          code: 'conflict',
        })
        await expect(fs.remove(`${base}/y.md`)).rejects.toMatchObject({ code: 'conflict' })
        await expect(fs.read(`${base}/x.md`)).rejects.toMatchObject({ code: 'conflict' })
        expect(await fs.stat(`${base}/x.md`)).toBeNull()
        await expect(fs.move(`${base}/x.md`, 'taken.md')).rejects.toMatchObject({
          code: 'conflict',
        })
        await expect(fs.move('real.md', `${base}/moved.md`)).rejects.toMatchObject({
          code: 'conflict',
        })
      }
      expect(await readFileText(join(outside, 'x.md'))).toBe('outside')
      expect(await readFileText(join(outside, 'y.md'))).toBe('outside y')
      expect((await readdir(outside)).sort()).toEqual(['x.md', 'y.md'])
      expect(await readFileText(join(root, 'real.md'))).toBe('real')
      expect(existsSync(join(root, 'taken.md'))).toBe(false)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('removes a file, and removing a missing path is not an error', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', bytes('a'), 1000)
    await fs.remove('a.md')
    expect(await fs.stat('a.md')).toBeNull()
    await expect(fs.remove('a.md')).resolves.toBeUndefined()
    await expect(fs.remove('never/existed.md')).resolves.toBeUndefined()
  })

  it('removes the folders a remove or a move emptied, and no other', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('Burst/deep/a.md', bytes('a'), 1000)
    await fs.writeAtomic('Kept/b.md', bytes('b'), 1000)
    await fs.writeAtomic('Kept/c.md', bytes('c'), 1000)
    await fs.writeAtomic('Moved/d.md', bytes('d'), 1000)
    // A folder the person left empty themselves is theirs, and stays.
    await mkdir(join(root, 'Empty'))

    await fs.remove('Burst/deep/a.md')
    await fs.remove('Kept/b.md')
    await fs.move('Moved/d.md', 'Elsewhere/d.md')

    expect(existsSync(join(root, 'Burst'))).toBe(false)
    expect(existsSync(join(root, 'Moved'))).toBe(false)
    expect(existsSync(join(root, 'Kept'))).toBe(true)
    expect(existsSync(join(root, 'Empty'))).toBe(true)
    expect(existsSync(root)).toBe(true)
    expect((await readdir(root)).sort()).toEqual(['.abele-sync', 'Elsewhere', 'Empty', 'Kept'])
  })

  it('leaves a folder the engine emptied when something else has come to hold it', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('Notes/a.md', bytes('a'), 1000)
    await writeFile(join(root, 'Notes', '.DS_Store'), 'finder')
    await fs.remove('Notes/a.md')
    expect(await readdir(join(root, 'Notes'))).toEqual(['.DS_Store'])
  })

  it('calls a file stable when two stats agree, and unstable while it is growing', async () => {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('still.md', bytes('done'), 1000)
    expect(await fs.sizeStable('still.md')).toBe(true)
    expect(await fs.sizeStable('missing.md')).toBe(false)

    // The file grows between the two readings: after the first stat, while the gap's timer is
    // armed on a fake clock, rather than at a real moment a busy machine may run late.
    await fs.writeAtomic('growing.md', bytes('start'), 1000)
    vi.useFakeTimers(FAKE_CLOCK)
    const stable = fs.sizeStable('growing.md')
    await settle(() => vi.getTimerCount() > 0)
    await appendFile(join(root, 'growing.md'), 'more')
    vi.advanceTimersByTime(200)
    expect(await stable).toBe(false)
  })

  it.skipIf(!RECURSIVE_WATCH)('reports a write (recursive fs.watch)', async () => {
    const fs = new NodeFileSystem(root)
    expect(fs.supportsWatch).toBe(true)
    const seen: string[] = []
    const stop = fs.watch!((paths) => seen.push(...paths))
    try {
      await fs.writeAtomic('notes/watched.md', bytes('hi'), 1000)
      await waitFor(() => seen.includes('notes/watched.md'))
      expect(seen).toContain('notes/watched.md')
      expect(seen.filter((p) => p.startsWith('.abele-sync'))).toEqual([])
    } finally {
      stop()
    }
  })

  it.skipIf(!RECURSIVE_WATCH)(
    'never reports the state folder, whatever ignoreDirs says',
    async () => {
      const fs = new NodeFileSystem(root, { ignoreDirs: ['.trash'] })
      const seen: string[] = []
      const stop = fs.watch!((paths) => seen.push(...paths))
      try {
        await mkdir(join(root, '.abele-sync'), { recursive: true })
        await writeFile(join(root, '.abele-sync', 'config.json'), '{"deviceToken":"secret"}')
        await fs.writeAtomic('sentinel.md', bytes('hi'), 1000)
        await waitFor(() => seen.includes('sentinel.md'))
        expect(seen).toContain('sentinel.md')
        expect(seen.filter((p) => p.startsWith('.abele-sync'))).toEqual([])
      } finally {
        stop()
      }
    }
  )

  it.skipIf(!RECURSIVE_WATCH)(
    'with skipHidden, reports nothing from a hidden folder but .obsidian',
    async () => {
      await mkdir(join(root, '.git', 'objects'), { recursive: true })
      await mkdir(join(root, 'Sub', '.cache'), { recursive: true })
      await mkdir(join(root, '.obsidian'), { recursive: true })
      const fs = new NodeFileSystem(root, { skipHidden: true })
      const seen: string[] = []
      const stop = fs.watch!((paths) => seen.push(...paths))
      try {
        await writeFile(join(root, '.git', 'objects', 'pack'), 'churn')
        await writeFile(join(root, '.git', 'index'), 'churn')
        await writeFile(join(root, 'Sub', '.cache', 'blob'), 'churn')
        await writeFile(join(root, '.obsidian', 'app.json'), '{}')
        await fs.writeAtomic('sentinel.md', bytes('hi'), 1000)
        await waitFor(() => seen.includes('sentinel.md') && seen.includes('.obsidian/app.json'))
        expect(seen).toContain('.obsidian/app.json')
        expect(seen.filter((p) => p.startsWith('.git') || p.includes('/.cache'))).toEqual([])
      } finally {
        stop()
      }
    }
  )

  it.skipIf(!RECURSIVE_WATCH)(
    'reports what changed, deletions and files in folders included',
    async () => {
      // The folder is there before the watch is armed: macOS drops the odd mkdir event outright
      // (about one in two hundred, never merely late), and a folder's arrival has a test of its
      // own below. What is asserted here is the change inside it, and a deletion.
      await mkdir(join(root, 'folder'))
      const fs = new NodeFileSystem(root)
      const seen: string[] = []
      const stop = fs.watch!((paths) => seen.push(...paths))
      try {
        await writeFile(join(root, 'folder', 'note.md'), 'hi')
        await writeFile(join(root, 'gone.md'), 'bye')
        await rm(join(root, 'gone.md'))
        await waitFor(() => seen.includes('folder/note.md') && seen.includes('gone.md'))
        expect(seen).toContain('folder/note.md')
        expect(seen).toContain('gone.md')
        // macOS reports the vault's own name for a change to the vault folder itself, and
        // there is no file by that name here.
        expect(seen).not.toContain(basename(root))
      } finally {
        stop()
      }
    }
  )

  it.skipIf(!RECURSIVE_WATCH)(
    'wakes on a folder moved in, whose notes are never reported on their own',
    async () => {
      const staging = await mkdtemp(join(tmpdir(), 'abele-staged-'))
      const fs = new NodeFileSystem(root)
      const seen: string[] = []
      const stop = fs.watch!((paths) => seen.push(...paths))
      try {
        await mkdir(join(staging, 'Imported'))
        await writeFile(join(staging, 'Imported', 'one.md'), '1')
        await writeFile(join(staging, 'Imported', 'two.md'), '2')
        await rename(join(staging, 'Imported'), join(root, 'Imported'))
        await waitFor(() => seen.length > 0)
        // The one word the engine gets that two notes arrived: the folder itself. macOS says
        // nothing about the files inside it — only the vault's own echo, which is dropped.
        expect(seen).toContain('Imported')
        expect(seen).not.toContain(basename(root))
      } finally {
        stop()
        await rm(staging, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(!RECURSIVE_WATCH)(
    'reports a file that carries the vault folder name, and its deletion',
    async () => {
      const fs = new NodeFileSystem(root)
      const batches: string[][] = []
      const stop = fs.watch!((paths) => batches.push(paths))
      const name = basename(root)
      try {
        await writeFile(join(root, name), 'hi')
        await waitFor(() => batches.flat().includes(name))
        expect(batches.flat()).toContain(name)

        const afterCreate = batches.length
        await rm(join(root, name))
        await waitFor(() => batches.length > afterCreate)
        expect(batches.slice(afterCreate).flat()).toContain(name)
      } finally {
        stop()
      }
    }
  )

  it.skipIf(!RECURSIVE_WATCH)('hands over a lone change one debounce after it', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    const fs = new NodeFileSystem(root)
    const batches: string[][] = []
    const stop = fs.watch!((paths) => batches.push(paths))
    try {
      emit('lone.md')
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1)
      expect(batches).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await settle(() => batches.length > 0)
      expect(batches).toEqual([['lone.md']])
    } finally {
      stop()
    }
  })

  it.skipIf(!RECURSIVE_WATCH)('hands over a batch during a burst that never lets up', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    const fs = new NodeFileSystem(root)
    const batches: string[][] = []
    const stop = fs.watch!((paths) => batches.push(paths))
    const names = Array.from({ length: 60 }, (_, i) => `burst-${i}.md`)
    try {
      // A change every 50 ms for 3 s: the debounce never runs out, so only the 2 s ceiling can
      // hand a batch over before the burst ends.
      for (const name of names) {
        emit(name)
        vi.advanceTimersByTime(50)
      }
      vi.advanceTimersByTime(DEBOUNCE_MS)
      await settle(() => batches.flat().length >= names.length)

      expect(batches.flat()).toEqual(names)
      expect(batches.length).toBeGreaterThanOrEqual(2)
      // The first batch closed within the ceiling plus one debounce, well before the burst did.
      expect(batches[0]!.length).toBeLessThanOrEqual((MAX_WAIT_MS + DEBOUNCE_MS) / 50 + 1)
    } finally {
      stop()
    }
  })

  it.skipIf(!RECURSIVE_WATCH)('hands over batches in the order the disk made them', async () => {
    vi.useFakeTimers(FAKE_CLOCK)
    const fs = new NodeFileSystem(root)
    const batches: string[][] = []
    const stop = fs.watch!((paths) => batches.push(paths))
    try {
      // The first batch carries the vault folder's own name, which the echo filter has to stat
      // before it can report anything; the second needs no stat and is ready at once. Both
      // batches close before either stat can come back, so only the watcher's own queue keeps
      // the second from overtaking the first.
      emit(basename(root))
      emit('first.md')
      vi.advanceTimersByTime(DEBOUNCE_MS)
      emit('second.md')
      vi.advanceTimersByTime(DEBOUNCE_MS)
      await settle(() => batches.length >= 2)

      // One window of the disk's history per batch, handed over in the order it was made.
      expect(batches).toEqual([['first.md'], ['second.md']])
    } finally {
      stop()
    }
  })

  it.skipIf(!RECURSIVE_WATCH)('says nothing more once it has been stopped', async () => {
    const fs = new NodeFileSystem(root)
    const seen: string[] = []
    const stop = fs.watch!((paths) => seen.push(...paths))
    await writeFile(join(root, 'before.md'), '1')
    await waitFor(() => seen.includes('before.md'))
    const reported = seen.length

    stop()
    await writeFile(join(root, 'after.md'), '2')
    // Longer than the debounce, so a batch that was still coming would have arrived.
    await new Promise((r) => setTimeout(r, 800))
    expect(seen.length).toBe(reported)
    expect(seen).not.toContain('after.md')
  })

  it.skipIf(!RECURSIVE_WATCH)(
    'drops the batch it was still collecting when it stopped',
    async () => {
      const fs = new NodeFileSystem(root)
      const seen: string[] = []
      const stop = fs.watch!((paths) => seen.push(...paths))
      // Stopped well inside the debounce window: the batch exists and is never handed over.
      await writeFile(join(root, 'pending.md'), '1')
      stop()
      await new Promise((r) => setTimeout(r, 800))
      expect(seen).toEqual([])
    }
  )

  it.skipIf(RECURSIVE_WATCH)('offers no watch where recursive fs.watch is unsupported', () => {
    const fs = new NodeFileSystem(root)
    expect(fs.supportsWatch).toBe(false)
    expect(fs.watch).toBeUndefined()
  })
})
