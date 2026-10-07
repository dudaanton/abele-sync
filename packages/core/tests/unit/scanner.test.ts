import { normalisePath } from '@abele/sync-protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  encodeText,
  MemoryFileSystem,
  MemoryStateStore,
  scan,
  sha256,
  type ScanFilter,
  type ScanResult,
  type StateEntry,
} from '../../src/index.js'

/** A filter that lets everything through: the scanner's own guards still apply. */
const ALL: ScanFilter = { excluded: () => false }

/** A filter that excludes the listed wire paths, and nothing else. */
function excluding(...paths: string[]): ScanFilter {
  const set = new Set(paths)
  return { excluded: (wirePath) => set.has(wirePath) }
}

const shaOf = (text: string): Promise<string> => sha256(encodeText(text))

/** A `hash` option that remembers how many times the scanner reached for it. */
function counting(): { hash: (bytes: Uint8Array) => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    hash: (bytes) => {
      calls++
      return sha256(bytes)
    },
    calls: () => calls,
  }
}

/**
 * Lookups and element visits made while `run` is awaited: every Map and Set lookup, and every
 * element an array search or filter walks. A pass that re-scans its candidates per candidate
 * shows up here as a count that grows with the square of the input, where a clock only showed
 * it on an idle machine. Anything else running meanwhile adds a little; the bounds are loose
 * enough for that and far below what a quadratic pass makes.
 */
async function countingWork<T>(run: () => Promise<T>): Promise<{ result: T; work: number }> {
  let work = 0
  const mapGet = Map.prototype.get
  const mapHas = Map.prototype.has
  const setHas = Set.prototype.has
  const walks = ['filter', 'find', 'findIndex', 'some', 'every', 'indexOf', 'includes'] as const
  const originals = walks.map((name) => Array.prototype[name])
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    work++
    return mapGet.call(this, key)
  }
  Map.prototype.has = function (this: Map<unknown, unknown>, key: unknown) {
    work++
    return mapHas.call(this, key)
  }
  Set.prototype.has = function (this: Set<unknown>, value: unknown) {
    work++
    return setHas.call(this, value)
  }
  walks.forEach((name, i) => {
    const original = originals[i] as (...args: unknown[]) => unknown
    Object.defineProperty(Array.prototype, name, {
      configurable: true,
      writable: true,
      value: function (this: unknown[], ...args: unknown[]) {
        work += this.length
        return original.apply(this, args)
      },
    })
  })
  try {
    const result = await run()
    return { result, work }
  } finally {
    Map.prototype.get = mapGet
    Map.prototype.has = mapHas
    Set.prototype.has = setHas
    walks.forEach((name, i) => {
      Object.defineProperty(Array.prototype, name, {
        configurable: true,
        writable: true,
        value: originals[i],
      })
    })
  }
}

let ids = 0

/** A disk and the state beside it, with `sync()` standing in for a clean push. */
class Vault {
  readonly fs = new MemoryFileSystem()
  readonly state = new MemoryStateStore()

  write(path: string, text: string, mtime = 1000): Promise<void> {
    return this.fs.writeAtomic(path, encodeText(text), mtime)
  }

  rm(path: string): Promise<void> {
    return this.fs.remove(path)
  }

  mv(from: string, to: string): Promise<void> {
    return this.fs.move(from, to)
  }

  /** Record the whole disk as last synced: keeps each file's id, stamps a fresh version. */
  async sync(): Promise<void> {
    const seen = new Set<string>()
    for await (const info of this.fs.list()) {
      seen.add(info.path)
      const existing = await this.state.get(info.path)
      await this.state.put({
        path: info.path,
        wirePath: normalisePath(info.path),
        fileId: existing?.fileId ?? `file-${++ids}`,
        versionId: `ver-${++ids}`,
        sha: await sha256(await this.fs.read(info.path)),
        size: info.size,
        mtime: info.mtime,
      })
    }
    for (const entry of await this.entries()) {
      if (!seen.has(entry.path)) await this.state.delete(entry.path)
    }
  }

  async entries(): Promise<StateEntry[]> {
    const found: StateEntry[] = []
    for await (const entry of this.state.all()) found.push(entry)
    return found
  }

  /** The state entry for an on-disk path, which the tests read ids off. */
  async entry(path: string): Promise<StateEntry> {
    const found = await this.state.get(path)
    if (!found) throw new Error(`no state entry for ${path}`)
    return found
  }
}

describe('scan', () => {
  let vault: Vault

  beforeEach(() => {
    vault = new Vault()
  })

  const run = (
    filter: ScanFilter = ALL,
    hash?: (bytes: Uint8Array) => Promise<string>
  ): Promise<ScanResult> => scan(vault.fs, vault.state, filter, hash ? { hash } : {})

  it('makes a create for every file of a fresh tree, in path order', async () => {
    await vault.write('b.md', 'bee')
    await vault.write('a.md', 'ay')
    await vault.write('sub/c.md', 'see')

    const { hash, calls } = counting()
    const result = await run(ALL, hash)

    expect(result.ops).toEqual([
      { op: 'create', path: 'a.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
      { op: 'create', path: 'b.md', sha: await shaOf('bee'), size: 3, mtime: 1000 },
      { op: 'create', path: 'sub/c.md', sha: await shaOf('see'), size: 3, mtime: 1000 },
    ])
    expect(calls()).toBe(3)
    expect(result.dirty).toEqual(new Set(['a.md', 'b.md', 'sub/c.md']))
    expect([...result.hashes.keys()].sort()).toEqual(['a.md', 'b.md', 'sub/c.md'])
    expect(result.diskPaths.get('sub/c.md')).toBe('sub/c.md')
    expect(result.skipped).toEqual([])
  })

  it('hashes the tree itself when no hash is given', async () => {
    await vault.write('a.md', 'ay')

    const result = await scan(vault.fs, vault.state, ALL)

    expect(result.ops).toEqual([
      { op: 'create', path: 'a.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
    ])
  })

  it('leaves an unchanged tree alone without hashing a byte of it', async () => {
    await vault.write('a.md', 'ay')
    await vault.write('b.md', 'bee')
    await vault.sync()

    const { hash, calls } = counting()
    const result = await run(ALL, hash)

    expect(result.ops).toEqual([])
    expect(calls()).toBe(0)
    expect(result.dirty).toEqual(new Set())
    expect(result.hashes.get('a.md')).toBe(await shaOf('ay'))
    expect(result.hashes.get('b.md')).toBe(await shaOf('bee'))
    expect(result.diskPaths.get('a.md')).toBe('a.md')
  })

  it('hashes a file whose mtime moved but reports no op when the sha is the same', async () => {
    await vault.write('a.md', 'ay')
    await vault.sync()
    await vault.write('a.md', 'ay', 2000)

    const { hash, calls } = counting()
    const result = await run(ALL, hash)

    expect(result.ops).toEqual([])
    expect(calls()).toBe(1)
    expect(result.dirty).toEqual(new Set())
    // The engine refreshes the entry's mtime off this, so the next scan hashes nothing.
    expect(result.hashes.get('a.md')).toBe(await shaOf('ay'))
  })

  it('makes a modify for a file whose content changed', async () => {
    await vault.write('a.md', 'ay')
    await vault.sync()
    const before = await vault.entry('a.md')
    await vault.write('a.md', 'ay again', 2000)

    const result = await run()

    expect(result.ops).toEqual([
      {
        op: 'modify',
        file_id: before.fileId,
        base_version_id: before.versionId,
        sha: await shaOf('ay again'),
        size: 8,
        mtime: 2000,
      },
    ])
    expect(result.dirty).toEqual(new Set(['a.md']))
  })

  it('makes a delete for a state entry with no file on disk', async () => {
    await vault.write('a.md', 'ay')
    await vault.write('b.md', 'bee')
    await vault.sync()
    const gone = await vault.entry('b.md')
    await vault.rm('b.md')

    const result = await run()

    expect(result.ops).toEqual([
      { op: 'delete', file_id: gone.fileId, base_version_id: gone.versionId },
    ])
    expect(result.dirty).toEqual(new Set(['b.md']))
    expect(result.hashes.has('b.md')).toBe(false)
  })

  it('pairs a lost path and a fresh one with the same sha into a move, with no modify', async () => {
    await vault.write('a.md', 'ay')
    await vault.sync()
    const moved = await vault.entry('a.md')
    await vault.mv('a.md', 'moved/b.md')

    const result = await run()

    expect(result.ops).toEqual([
      {
        op: 'move',
        file_id: moved.fileId,
        base_version_id: moved.versionId,
        to_path: 'moved/b.md',
      },
    ])
    expect(result.dirty).toEqual(new Set(['a.md', 'moved/b.md']))
  })

  /**
   * A lost note and a fresh one are an edited rename only when their text is clearly the same
   * note: at least half their lines shared. Pairing by elimination alone is unsafe. The lost note's text is gone from the disk, so the scan asks `previous` for
   * it — the engine reads it from the server.
   */
  const OLD = 'title\nfirst line\nsecond line\nthird line\n'
  const previousOf =
    (texts: Record<string, string>) =>
    async (entry: StateEntry): Promise<Uint8Array | null> =>
      texts[entry.wirePath] === undefined ? null : encodeText(texts[entry.wirePath]!)

  it('pairs a lost note with a fresh one that shares most of its lines, and modifies it', async () => {
    await vault.write('a.md', OLD)
    await vault.sync()
    const moved = await vault.entry('a.md')
    await vault.rm('a.md')
    const edited = `${OLD}a line added on the way\n`
    await vault.write('b.md', edited, 2000)

    const result = await scan(vault.fs, vault.state, ALL, {
      previous: previousOf({ 'a.md': OLD }),
    })

    expect(result.ops).toEqual([
      { op: 'move', file_id: moved.fileId, base_version_id: moved.versionId, to_path: 'b.md' },
      {
        op: 'modify',
        file_id: moved.fileId,
        base_version_id: moved.versionId,
        sha: await shaOf(edited),
        size: encodeText(edited).length,
        mtime: 2000,
      },
    ])
    expect(result.dirty).toEqual(new Set(['a.md', 'b.md']))
  })

  it('leaves a lost note and an unrelated fresh note as a delete and a create', async () => {
    await vault.write('a.md', OLD)
    await vault.sync()
    const gone = await vault.entry('a.md')
    await vault.rm('a.md')
    const other = 'shopping\nmilk\nbread\n'
    await vault.write('b.md', other, 2000)

    const result = await scan(vault.fs, vault.state, ALL, {
      previous: previousOf({ 'a.md': OLD }),
    })

    expect(result.ops).toEqual([
      { op: 'delete', file_id: gone.fileId, base_version_id: gone.versionId },
      { op: 'create', path: 'b.md', sha: await shaOf(other), size: 20, mtime: 2000 },
    ])
  })

  it('pairs nothing on content it cannot read back', async () => {
    await vault.write('a.md', OLD)
    await vault.sync()
    const gone = await vault.entry('a.md')
    await vault.rm('a.md')
    await vault.write('b.md', `${OLD}more\n`, 2000)

    // No way to read the lost note's text: nothing to judge the likeness by.
    const result = await run()

    expect(result.ops.map((op) => op.op)).toEqual(['delete', 'create'])
    expect(result.ops[0]).toMatchObject({ file_id: gone.fileId })
  })

  it('never pairs two attachments of different bytes, however alike', async () => {
    await vault.write('a.png', OLD)
    await vault.sync()
    await vault.rm('a.png')
    await vault.write('b.png', `${OLD}more\n`, 2000)

    const result = await scan(vault.fs, vault.state, ALL, {
      previous: previousOf({ 'a.png': OLD }),
    })

    expect(result.ops.map((op) => op.op)).toEqual(['delete', 'create'])
  })

  // Elimination pairs on nothing but what is left over, so it asks for the one thing a rename
  // always keeps: the extension. A note that went and a picture that arrived are two files.
  it('leaves a lost note and a fresh picture as a delete and a create', async () => {
    await vault.write('a.md', 'ay')
    await vault.sync()
    const gone = await vault.entry('a.md')
    await vault.rm('a.md')
    await vault.write('photo.png', 'not a note at all', 2000)

    const result = await run()

    expect(result.ops).toEqual([
      { op: 'delete', file_id: gone.fileId, base_version_id: gone.versionId },
      {
        op: 'create',
        path: 'photo.png',
        sha: await shaOf('not a note at all'),
        size: 17,
        mtime: 2000,
      },
    ])
    expect(result.dirty).toEqual(new Set(['a.md', 'photo.png']))
  })

  it('makes two creates for two new files with the same content', async () => {
    await vault.write('x.md', 'same')
    await vault.write('y.md', 'same')

    const result = await run()

    const sha = await shaOf('same')
    expect(result.ops).toEqual([
      { op: 'create', path: 'x.md', sha, size: 4, mtime: 1000 },
      { op: 'create', path: 'y.md', sha, size: 4, mtime: 1000 },
    ])
  })

  // The rule: a sha that names more than one candidate on either side pairs with none of
  // them. Two files with identical content, both renamed, are two deletes and two creates,
  // and the server keeps the content by sha either way.
  it('pairs nothing when two identical files are both renamed', async () => {
    await vault.write('a.md', 'same')
    await vault.write('b.md', 'same')
    await vault.sync()
    const first = await vault.entry('a.md')
    const second = await vault.entry('b.md')
    await vault.mv('a.md', 'c.md')
    await vault.mv('b.md', 'd.md')

    const result = await run()

    const sha = await shaOf('same')
    expect(result.ops).toEqual([
      { op: 'delete', file_id: first.fileId, base_version_id: first.versionId },
      { op: 'delete', file_id: second.fileId, base_version_id: second.versionId },
      { op: 'create', path: 'c.md', sha, size: 4, mtime: 1000 },
      { op: 'create', path: 'd.md', sha, size: 4, mtime: 1000 },
    ])
    expect(result.dirty).toEqual(new Set(['a.md', 'b.md', 'c.md', 'd.md']))
  })

  it('skips an excluded file on disk, size and all', async () => {
    await vault.write('a.md', 'ay')
    await vault.write('big.bin', 'far too many bytes')

    const result = await run({ excluded: (_wirePath, size) => size > 4 })

    expect(result.ops).toEqual([
      { op: 'create', path: 'a.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
    ])
    expect(result.hashes.has('big.bin')).toBe(false)
    expect(result.diskPaths.has('big.bin')).toBe(false)
    // Exclusion is the device's own settled choice, not something to report as a problem.
    expect(result.skipped).toEqual([])
  })

  it('makes no delete for an excluded state entry whose file is gone', async () => {
    await vault.write('a.md', 'ay')
    await vault.write('secret.md', 'shh')
    await vault.sync()
    await vault.rm('secret.md')

    const result = await run(excluding('secret.md'))

    expect(result.ops).toEqual([])
    expect(result.dirty).toEqual(new Set())
  })

  it('makes no delete for a file on disk that grew past the cap since it was synced', async () => {
    await vault.write('big.bin', 'ay')
    await vault.sync()
    await vault.write('big.bin', 'far too many bytes', 2000)

    // The entry remembers two bytes, so the state side of the filter says nothing: it is the
    // listing that must remember the file is still there, or this would look like a deletion.
    const result = await run({ excluded: (_wirePath, size) => size > 4 })

    expect(result.ops).toEqual([])
    expect(result.dirty).toEqual(new Set())
  })

  it('modifies a file that has come back under the cap instead of creating it again', async () => {
    await vault.write('big.bin', 'far too many bytes')
    await vault.sync()
    const before = await vault.entry('big.bin')
    await vault.write('big.bin', 'ay', 2000)

    // The entry looks excluded on its own remembered size; the file at that wire path is
    // still the same file, and must modify its entry rather than open a second one.
    const result = await run({ excluded: (_wirePath, size) => size > 4 })

    expect(result.ops).toEqual([
      {
        op: 'modify',
        file_id: before.fileId,
        base_version_id: before.versionId,
        sha: await shaOf('ay'),
        size: 2,
        mtime: 2000,
      },
    ])
  })

  it('never touches the engine folder, whatever the filter says', async () => {
    await vault.write('.abele-sync/state.json', '{}')
    await vault.write('.abele-sync-ignore', 'build/')
    await vault.write('a.md', 'ay')

    const result = await run()

    expect(result.ops).toEqual([
      { op: 'create', path: 'a.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
    ])
    expect(result.hashes.has('.abele-sync/state.json')).toBe(false)
    expect(result.skipped).toEqual([])
  })

  it('skips a path the wire will not take, with the reason', async () => {
    await vault.write('a:b.md', 'ay')
    await vault.write('a.md', 'ay')

    const log: string[] = []
    const result = await scan(vault.fs, vault.state, ALL, { log: (m) => log.push(m) })

    expect(result.skipped).toEqual([{ path: 'a:b.md', reason: 'forbidden character' }])
    expect(result.ops.map((op) => op.op)).toEqual(['create'])
    expect(log.join('\n')).toContain('a:b.md')
  })

  it('keeps the ordinal-lowest of two disk paths that mean the same wire path', async () => {
    await vault.write('cafe\u0301.md', 'ay')
    await vault.write('café.md', 'ay')

    const result = await run()

    expect(result.skipped).toEqual([{ path: 'café.md', reason: 'duplicate wire path' }])
    expect(result.ops).toEqual([
      { op: 'create', path: 'café.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
    ])
  })

  // A twin the adapter happens to list first must not take the synced file's place: that
  // would push the twin's bytes under the entry's id and call it a modify.
  it.each([false, true])(
    'keeps the synced spelling of a twinned path (twin first: %s)',
    async (twinFirst) => {
      const vault = new Vault()
      await vault.write('café.md', 'ay')
      await vault.sync()
      if (twinFirst) {
        // Re-listing the synced file after the twin: same size and mtime, so still unchanged.
        await vault.rm('café.md')
        await vault.write('cafe\u0301.md', 'ay')
        await vault.write('café.md', 'ay')
      } else {
        await vault.write('cafe\u0301.md', 'ay')
      }

      const result = await scan(vault.fs, vault.state, ALL)

      expect(result.ops).toEqual([])
      expect(result.skipped).toEqual([{ path: 'cafe\u0301.md', reason: 'duplicate wire path' }])
      expect(result.diskPaths.get('café.md')).toBe('café.md')
    }
  )

  it('does not let an over-cap twin shadow the spelling this device syncs', async () => {
    await vault.write('cafe\u0301.md', 'far too many bytes')
    await vault.write('café.md', 'ay')

    const result = await run({ excluded: (_wirePath, size) => size > 4 })

    expect(result.ops).toEqual([
      { op: 'create', path: 'café.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
    ])
    expect(result.diskPaths.get('café.md')).toBe('café.md')
    expect(result.skipped).toEqual([])
  })

  it('skips a file that cannot be read, and does not call it deleted', async () => {
    await vault.write('a.md', 'ay')
    await vault.write('b.md', 'bee')
    await vault.sync()
    await vault.write('b.md', 'bee, edited', 2000)
    vault.fs.read = (path: string): Promise<Uint8Array> => {
      throw new Error(`gone while we looked: ${path}`)
    }

    const result = await run()

    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ path: 'b.md', reason: 'gone while we looked: b.md' }])
    expect(result.hashes.has('b.md')).toBe(false)
    expect(result.diskPaths.has('b.md')).toBe(false)
  })

  it('speaks NFC on the wire and keeps the on-disk spelling for the host', async () => {
    await vault.write('notes/cafe\u0301.md', 'ay')

    const result = await run()

    expect(result.ops).toEqual([
      { op: 'create', path: 'notes/café.md', sha: await shaOf('ay'), size: 2, mtime: 1000 },
    ])
    expect(result.dirty).toEqual(new Set(['notes/café.md']))
    expect(result.diskPaths.get('notes/café.md')).toBe('notes/cafe\u0301.md')
    expect(result.hashes.get('notes/café.md')).toBe(await shaOf('ay'))
  })

  it('matches a decomposed disk path to its composed state entry', async () => {
    await vault.write('notes/cafe\u0301.md', 'ay')
    await vault.sync()

    const { hash, calls } = counting()
    const result = await run(ALL, hash)

    expect(result.ops).toEqual([])
    expect(calls()).toBe(0)
  })

  // Rename pairing buckets by sha instead of scanning the candidates once per candidate: the
  // first sync of a real vault is thousands of fresh paths at once, on the host's UI thread.
  // Counted rather than timed: doubling the vault must no more than double the work, where the
  // quadratic pairing quadruples it — and at this size makes tens of millions of lookups.
  it('pairs a vault-sized batch of fresh paths in linear time', async () => {
    const workFor = async (count: number): Promise<number> => {
      const disk = new Vault()
      for (let i = 0; i < count; i++) await disk.write(`notes/${i}.md`, `note ${i}`)
      let hashed = 0
      const stub = (): Promise<string> => Promise.resolve(String(++hashed).padStart(64, '0'))
      const { result, work } = await countingWork(() =>
        scan(disk.fs, disk.state, ALL, { hash: stub })
      )
      expect(result.ops).toHaveLength(count)
      expect(result.ops.every((op) => op.op === 'create')).toBe(true)
      return work
    }

    const half = await workFor(5_000)
    const full = await workFor(10_000)

    expect(full).toBeLessThan(2.5 * half)
    expect(full).toBeLessThan(100 * 10_000)
  })

  it('orders deletes and moves before modifies before creates', async () => {
    await vault.write('edit.md', 'edit')
    await vault.write('gone.md', 'gone')
    await vault.write('gone2.md', 'gone too')
    await vault.write('old.md', 'old')
    await vault.write('keep.md', 'keep')
    await vault.sync()
    const edit = await vault.entry('edit.md')
    const gone = await vault.entry('gone.md')
    const gone2 = await vault.entry('gone2.md')
    const old = await vault.entry('old.md')

    await vault.write('edit.md', 'edited', 2000)
    await vault.rm('gone.md')
    await vault.rm('gone2.md')
    await vault.mv('old.md', 'new.md')
    await vault.write('brand.md', 'brand new', 2000)

    const result = await run()

    expect(result.ops).toEqual([
      { op: 'delete', file_id: gone.fileId, base_version_id: gone.versionId },
      { op: 'delete', file_id: gone2.fileId, base_version_id: gone2.versionId },
      { op: 'move', file_id: old.fileId, base_version_id: old.versionId, to_path: 'new.md' },
      {
        op: 'modify',
        file_id: edit.fileId,
        base_version_id: edit.versionId,
        sha: await shaOf('edited'),
        size: 6,
        mtime: 2000,
      },
      { op: 'create', path: 'brand.md', sha: await shaOf('brand new'), size: 9, mtime: 2000 },
    ])
    expect(result.dirty).toEqual(
      new Set(['gone.md', 'gone2.md', 'old.md', 'new.md', 'edit.md', 'brand.md'])
    )
    expect(result.dirty.has('keep.md')).toBe(false)
  })

  it('holds back a fresh path named like a synced file but for case, and says so', async () => {
    await vault.write('Image.png', 'the synced one')
    await vault.write('Notes/Café.md', 'synced note')
    await vault.sync()
    // A case-sensitive disk takes both spellings; the wire and the server take one.
    await vault.write('image.png', 'a stranger', 500)
    await vault.write('notes/cafe\u0301.MD', 'another stranger', 500)
    await vault.write('fresh.md', 'unrelated')
    const { hash, calls } = counting()

    const result = await run(ALL, hash)

    expect(result.ops).toEqual([
      { op: 'create', path: 'fresh.md', sha: await shaOf('unrelated'), size: 9, mtime: 1000 },
    ])
    expect(result.collisions).toEqual([
      { path: 'image.png', wirePath: 'image.png', with: 'Image.png' },
      { path: 'notes/cafe\u0301.MD', wirePath: 'notes/caf\u00e9.MD', with: 'Notes/Caf\u00e9.md' },
    ])
    expect(result.dirty).toEqual(new Set(['fresh.md']))
    expect(result.hashes.has('image.png')).toBe(false)
    // Held paths are not read: they would be on every scan until somebody renames one.
    expect(calls()).toBe(1)
  })

  it('still takes a case-only rename on a case-sensitive disk as a move', async () => {
    await vault.write('Image.png', 'the synced one')
    await vault.sync()
    const entry = await vault.entry('Image.png')
    await vault.mv('Image.png', 'image.png')

    const result = await run()

    expect(result.ops).toEqual([
      { op: 'move', file_id: entry.fileId, base_version_id: entry.versionId, to_path: 'image.png' },
    ])
    expect(result.collisions).toEqual([])
  })
})
