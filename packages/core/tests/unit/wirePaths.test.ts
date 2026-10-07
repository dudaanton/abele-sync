import type { ChangeItem, CommitOpResult, ManifestItem } from '@abele/sync-protocol'
import { describe, expect, it } from 'vitest'
import {
  encodeText,
  EngineError,
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  pull,
  push,
  scan,
  sha256,
  type PullReport,
  type ScanFilter,
  type VaultClient,
} from '../../src/index.js'

/**
 * Paths the server has no business sending, and what the engine does with them: nothing.
 *
 * The server here is a fake, because the real one validates its own paths and would never
 * hand these out; what is being checked is that the engine does not trust it to. Every
 * change and every commit result is checked in core, before any adapter sees a path, and
 * a bad one is passed over — the cursor moves on, the report says `skipped`, and the sync
 * does not fail on it every time from then on.
 */

const ALL: ScanFilter = { excluded: () => false }

/** Every shape §3.8 forbids that an adapter might otherwise turn into a way out of the vault. */
const HOSTILE = [
  '../../escape.md',
  '/etc/passwd',
  'a/../../b.md',
  './.abele-sync/config.json',
  'a\\b.md',
]

const bytes = encodeText('not to be written')
let shaOfBytes: string

async function shaOf(): Promise<string> {
  shaOfBytes ??= await sha256(bytes)
  return shaOfBytes
}

const change = (seq: number, path: string, over: Partial<ChangeItem> = {}): ChangeItem => ({
  seq,
  file_id: `file-${seq}`,
  op: 'create',
  path,
  prev_path: null,
  sha: shaOfBytes,
  size: bytes.length,
  mtime: 1000,
  version_id: `ver-${seq}`,
  kind: 'note',
  actor: { kind: 'device', id: 'd', name: 'd' },
  at: '2026-09-05T00:00:00.000Z',
  ...over,
})

const item = (seq: number, path: string): ManifestItem => ({
  file_id: `file-${seq}`,
  path,
  kind: 'note',
  version_id: `ver-${seq}`,
  seq,
  sha: shaOfBytes,
  size: bytes.length,
  mtime: 1000,
})

/** A server that answers only what a test names, and refuses the rest loudly. */
function fakeClient(over: Partial<VaultClient>): VaultClient {
  const never = (name: string) => async (): Promise<never> => {
    throw new Error(`the fake server was asked for ${name}`)
  }
  return {
    state: never('state'),
    manifest: never('manifest'),
    changes: never('changes'),
    getBlob: async () => bytes,
    hasBlob: async () => true,
    putBlob: never('putBlob'),
    commitRaw: never('commitRaw'),
    ...over,
  } as unknown as VaultClient
}

interface Disk {
  fs: MemoryFileSystem
  state: MemoryStateStore
  writes: string[]
  moves: string[]
  expected: ExpectedWrites
}

function disk(): Disk {
  const fs = new MemoryFileSystem()
  const writes: string[] = []
  const moves: string[] = []
  const write = fs.writeAtomic.bind(fs)
  fs.writeAtomic = async (path, data, mtime) => {
    writes.push(path)
    await write(path, data, mtime)
  }
  const move = fs.move.bind(fs)
  fs.move = async (from, to) => {
    moves.push(`${from} -> ${to}`)
    await move(from, to)
  }
  return { fs, state: new MemoryStateStore(), writes, moves, expected: new ExpectedWrites() }
}

const pullOver = (d: Disk, client: VaultClient, log: string[]): Promise<PullReport> =>
  pull(client, d.fs, d.state, {
    filter: ALL,
    dirty: new Set(),
    expected: d.expected,
    log: (line) => log.push(line),
  })

describe('paths off the wire', () => {
  it('passes over every hostile change in the feed, carrying the cursor past it', async () => {
    await shaOf()
    const d = disk()
    await d.state.setCursor(1)
    const feed = [...HOSTILE.map((path, at) => change(2 + at, path)), change(9, 'fine.md')]
    const client = fakeClient({
      changes: async () => ({ items: feed, head_seq: 9, next_since: 9 }),
    })
    const log: string[] = []

    const report = await pullOver(d, client, log)

    expect(d.writes).toEqual(['fine.md'])
    expect(d.moves).toEqual([])
    expect(report).toMatchObject({ applied: 1, held: [], skipped: HOSTILE.length, cursor: 9 })
    expect(await d.state.getCursor()).toBe(9)
    expect([...d.fs.snapshot().keys()]).toEqual(['fine.md'])
    expect(log.filter((line) => line.startsWith('pull: skipped'))).toHaveLength(HOSTILE.length)
    // Every reason is named, and none of the paths reached an adapter under any spelling.
    expect(log.join('\n')).toContain('dot segment')
    expect(log.join('\n')).toContain('not in wire form')
  })

  it('passes over a move whose old path is hostile, whatever the new one', async () => {
    await shaOf()
    const d = disk()
    await d.fs.writeAtomic('here.md', bytes, 1000)
    await d.state.put({
      path: 'here.md',
      wirePath: 'here.md',
      fileId: 'file-1',
      versionId: 'ver-1',
      sha: shaOfBytes,
      size: bytes.length,
      mtime: 1000,
    })
    await d.state.setCursor(1)
    const client = fakeClient({
      changes: async () => ({
        items: [
          change(2, 'there.md', {
            file_id: 'file-1',
            op: 'move',
            prev_path: '../../here.md',
            version_id: 'ver-2',
          }),
        ],
        head_seq: 2,
        next_since: 2,
      }),
    })

    const report = await pullOver(d, client, [])

    expect(report).toMatchObject({ applied: 0, held: [], skipped: 1, cursor: 2 })
    expect(d.moves).toEqual([])
    expect(await d.state.get('here.md')).toMatchObject({ versionId: 'ver-1' })
  })

  it('passes over every hostile item on the manifest, and finishes the walk', async () => {
    await shaOf()
    const d = disk()
    const items = [...HOSTILE.map((path, at) => item(1 + at, path)), item(9, 'fine.md')]
    const client = fakeClient({
      manifest: async () => ({ items, next: null, head_seq: 9 }),
      changes: async () => ({ items: [], head_seq: 9, next_since: 9 }),
    })

    const report = await pullOver(d, client, [])

    expect(d.writes).toEqual(['fine.md'])
    expect(report).toMatchObject({
      bootstrapped: true,
      applied: 1,
      held: [],
      skipped: HOSTILE.length,
      cursor: 9,
    })
  })

  it('records nothing for a commit result at a hostile path, and reports the op refused', async () => {
    await shaOf()
    const d = disk()
    await d.fs.writeAtomic('note.md', bytes, 1000)
    const gets: string[] = []
    let sent = 0
    const client = fakeClient({
      getBlob: async (sha) => {
        gets.push(sha)
        return bytes
      },
      commitRaw: async (ops) => {
        sent += 1
        const results: CommitOpResult[] = ops.map((_, at) => ({
          status: at === 0 ? 'applied' : 'merged',
          file_id: 'file-1',
          version_id: 'ver-1',
          seq: 1,
          path: HOSTILE[at % HOSTILE.length]!,
          sha: shaOfBytes,
          size: bytes.length,
          mtime: 1000,
        }))
        return { body: { head_seq: 1, results }, replayed: false }
      },
    })
    const log: string[] = []
    const found = await scan(d.fs, d.state, ALL)

    const report = await push(client, d.fs, d.state, found, {
      expected: d.expected,
      log: (line) => log.push(line),
    })

    expect(sent).toBe(1)
    expect(report.rejected.map((r) => r.code)).toEqual(['invalid_path'])
    expect(report).toMatchObject({ applied: 0, merged: 0, kept: [] })
    expect(d.writes).toEqual(['note.md'])
    expect(d.moves).toEqual([])
    expect(gets).toEqual([])
    expect(await d.state.get('note.md')).toBeNull()
    expect(await d.state.getJournal()).toBeNull()
    expect(log.join('\n')).toContain('will not take')
  })

  it('keeps a merged file on its base when the server cannot produce the bytes it named', async () => {
    await shaOf()
    const d = disk()
    await d.fs.writeAtomic('note.md', bytes, 1000)
    const merged = await sha256(encodeText('what the server says it merged'))
    const client = fakeClient({
      getBlob: async () => encodeText('but these are not those bytes'),
      commitRaw: async () => ({
        body: {
          head_seq: 1,
          results: [
            {
              status: 'merged',
              file_id: 'file-1',
              version_id: 'ver-1',
              seq: 1,
              path: 'note.md',
              sha: merged,
              size: 30,
              mtime: 2000,
            },
          ],
        },
        replayed: false,
      }),
    })
    const log: string[] = []
    const found = await scan(d.fs, d.state, ALL)

    const report = await push(client, d.fs, d.state, found, {
      expected: d.expected,
      log: (line) => log.push(line),
    })

    expect(report).toMatchObject({ merged: 1, kept: ['note.md'] })
    expect(d.writes).toEqual(['note.md'])
    expect(await d.fs.read('note.md')).toEqual(bytes)
    // A create has no base to keep, so nothing is recorded and the next scan sends it again.
    expect(await d.state.get('note.md')).toBeNull()
    expect(log.join('\n')).toContain('do not hash')
  })

  it('keeps a file where it was when the path the server moved it to is taken by a folder', async () => {
    await shaOf()
    const d = disk()
    await d.fs.writeAtomic('a.md', bytes, 1000)
    await d.state.put({
      path: 'a.md',
      wirePath: 'a.md',
      fileId: 'file-1',
      versionId: 'ver-1',
      sha: shaOfBytes,
      size: bytes.length,
      mtime: 1000,
    })
    // The edit goes up; the server's head had moved the file to `b.md`, so that is where it
    // lands — and `b.md` here is a folder, which the adapter says as `conflict`.
    await d.fs.writeAtomic('a.md', encodeText('edited'), 2000)
    const edited = await sha256(encodeText('edited'))
    const move = d.fs.move.bind(d.fs)
    d.fs.move = async (from, to) => {
      if (to === 'b.md') throw new EngineError('conflict', 'a folder is at b.md')
      await move(from, to)
    }
    const client = fakeClient({
      commitRaw: async () => ({
        body: {
          head_seq: 2,
          results: [
            {
              status: 'applied',
              file_id: 'file-1',
              version_id: 'ver-2',
              seq: 2,
              path: 'b.md',
              sha: edited,
              size: 6,
              mtime: 2000,
            },
          ],
        },
        replayed: false,
      }),
    })
    const log: string[] = []
    const found = await scan(d.fs, d.state, ALL)

    const report = await push(client, d.fs, d.state, found, {
      expected: d.expected,
      log: (line) => log.push(line),
    })

    expect(report).toMatchObject({ applied: 0, kept: ['b.md'] })
    expect(await d.state.getJournal()).toBeNull()
    expect(await d.state.get('a.md')).toMatchObject({ versionId: 'ver-1' })
    expect(await d.fs.read('a.md')).toEqual(encodeText('edited'))
    expect(log.join('\n')).toContain('a folder is at b.md')
  })
})
