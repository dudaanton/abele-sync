import type { CommitOp, CommitOpResult, CommitResponse } from '@abele/sync-protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  type PullOptions,
  type PullReport,
  type ScanFilter,
  type VaultClient,
} from '../../src/index.js'
import { BASE_URL, serverHarness, type Harness } from '../helpers/harness.js'

/**
 * The puller against a server in this process: every byte it applies came down the
 * device facet, and every seq it stops at is one the real feed handed out.
 */

/** A device that syncs the whole vault; the exclusion tests bring a filter of their own. */
const ALL: ScanFilter = { excluded: () => false }

const decoder = new TextDecoder()

/** Long enough for anything still running after a rejected pull to have finished. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

/** Bytes under the name they hash to, uploaded so a commit may name them. */
async function blob(client: VaultClient, text: string): Promise<{ sha: string; size: number }> {
  const bytes = encodeText(text)
  const sha = await sha256(bytes)
  await client.putBlob(sha, bytes)
  return { sha, size: bytes.length }
}

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('nothing there')
  return value
}

/** The name some text is filed under, for an assertion about what was written. */
const shaOfText = (text: string): Promise<string> => sha256(encodeText(text))

/** A create op for text this uploads first. */
async function createOp(
  client: VaultClient,
  path: string,
  text: string,
  mtime = 1000
): Promise<CommitOp> {
  return { op: 'create', path, ...(await blob(client, text)), mtime }
}

/** One batch under a key no other batch in this file uses. */
let keys = 0
const commit = (client: VaultClient, ops: CommitOp[]): Promise<CommitResponse> =>
  client.commit(ops, `puller-${++keys}`)

/** One result, insisting the server applied it, so a test can name the version it made. */
function applied(
  result: CommitOpResult | undefined
): Extract<CommitOpResult, { status: 'applied' }> {
  if (result?.status !== 'applied') throw new Error(`not applied: ${JSON.stringify(result)}`)
  return result
}

/** One result, insisting the server kept its head and copied the incoming bytes aside. */
function conflicted(
  result: CommitOpResult | undefined
): Extract<CommitOpResult, { status: 'conflict' }> {
  if (result?.status !== 'conflict') throw new Error(`not a conflict: ${JSON.stringify(result)}`)
  return result
}

/**
 * A device: a disk, what it last synced, and a client whose downloads are counted and
 * held open long enough for a second one to overlap. `writes` and `gets` are what the
 * assertions are really about — that the puller wrote once and downloaded nothing it
 * already had.
 */
interface Device {
  fs: MemoryFileSystem
  state: MemoryStateStore
  expected: ExpectedWrites
  /** Every path `writeAtomic` was given, in order. */
  writes: string[]
  /** Every sha fetched from the server, in order. */
  gets: string[]
  /** How many downloads were ever in flight at once, and how many are now. */
  flight: { now: number; peak: number }
  /** How often the puller hashed local bytes to check them. */
  hashed: { count: number }
  /** The error paths: a download or a write this answers true for throws instead. */
  fails: {
    get: ((sha: string, nth: number) => boolean) | null
    write: ((path: string, nth: number) => boolean) | null
  }
  pull(over?: Partial<PullOptions>): Promise<PullReport>
  text(path: string): Promise<string>
  /** Reset the counters so each subsequent check is independent. */
  forget(): void
}

function deviceOn(client: VaultClient, delay = 0): Device {
  const fs = new MemoryFileSystem()
  const state = new MemoryStateStore()
  const expected = new ExpectedWrites()
  const writes: string[] = []
  const gets: string[] = []
  const flight = { now: 0, peak: 0 }
  const hashed = { count: 0 }
  const fails: Device['fails'] = { get: null, write: null }

  const write = fs.writeAtomic.bind(fs)
  fs.writeAtomic = async (path, bytes, mtime) => {
    writes.push(path)
    if (fails.write?.(path, writes.length) === true) {
      throw new EngineError('io', `the disk refused ${path}`)
    }
    await write(path, bytes, mtime)
  }

  const getBlob = client.getBlob.bind(client)
  client.getBlob = async (sha) => {
    gets.push(sha)
    if (fails.get?.(sha, gets.length) === true) {
      throw new EngineError('offline', `the server never answered for ${sha}`)
    }
    flight.now += 1
    flight.peak = Math.max(flight.peak, flight.now)
    try {
      // A few turns of the microtask queue, so overlapping fetches really do overlap.
      for (let tick = 0; tick < delay; tick++) await Promise.resolve()
      return await getBlob(sha)
    } finally {
      flight.now -= 1
    }
  }

  const hash = async (bytes: Uint8Array): Promise<string> => {
    hashed.count += 1
    return sha256(bytes)
  }

  return {
    fs,
    state,
    expected,
    writes,
    gets,
    flight,
    hashed,
    fails,
    pull: (over = {}) =>
      pull(client, fs, state, { filter: ALL, dirty: new Set(), expected, hash, ...over }),
    text: async (path) => decoder.decode(await fs.read(path)),
    forget: () => {
      writes.length = 0
      gets.length = 0
      flight.peak = 0
      hashed.count = 0
    },
  }
}

describe('the puller over the device facet', () => {
  let h: Harness
  let accountToken: string

  interface Vault {
    vaultId: string
    deviceToken: string
    /** The client the test seeds the server with; its calls are never counted. */
    client: VaultClient
    /** A device of its own, on a client of its own. */
    device(delay?: number): Device
  }

  /** A vault of its own, with a device enrolled on it, so no test disturbs another. */
  async function ownVault(name: string): Promise<Vault> {
    const { vaultId } = await h.vault(accountToken, name)
    const { deviceToken } = await h.device(accountToken, vaultId, `${name} device`)
    return {
      vaultId,
      deviceToken,
      client: h.clientFor(deviceToken, vaultId),
      device: (delay = 0) => deviceOn(h.clientFor(deviceToken, vaultId), delay),
    }
  }

  /** Have this vault copy a losing edit aside rather than merge it. */
  async function copyConflictsAside(vault: Vault): Promise<void> {
    const response = await h.fetch(`${BASE_URL}/v1/vaults/${vault.vaultId}/settings`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${vault.deviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ conflict: 'conflict-file' }),
    })
    if (!response.ok) throw new Error(`settings answered ${response.status}`)
  }

  const headOf = async (vault: Vault): Promise<number> => (await vault.client.state()).head_seq

  beforeAll(async () => {
    h = await serverHarness()
    accountToken = (await h.account('puller@abele.test')).accountToken
  })

  afterAll(async () => {
    await h.close()
  })

  it('bootstraps a vault it has never seen from the manifest', async () => {
    const vault = await ownVault('bootstrap')
    const paths = ['a.md', 'b.md', 'notes/c.md', 'notes/d.md', 'e.txt']
    const ops: CommitOp[] = []
    for (const [i, path] of paths.entries()) {
      ops.push(await createOp(vault.client, path, `body of ${path}`, 1000 + i))
    }
    const made = await commit(vault.client, ops)

    const d = vault.device()
    const report = await d.pull()

    expect(report.bootstrapped).toBe(true)
    expect(report.applied).toBe(5)
    expect(report.held).toEqual([])
    expect(report.skipped).toBe(0)
    expect(report.cursor).toBe(await headOf(vault))
    expect(await d.state.getCursor()).toBe(report.cursor)

    expect([...d.writes].sort()).toEqual([...paths].sort())
    expect(await d.text('notes/c.md')).toBe('body of notes/c.md')
    expect(await d.fs.stat('a.md')).toEqual({
      path: 'a.md',
      size: 'body of a.md'.length,
      mtime: 1000,
    })
    const first = applied(made.results[0])
    expect(await d.state.get('a.md')).toMatchObject({
      path: 'a.md',
      wirePath: 'a.md',
      fileId: first.file_id,
      versionId: first.version_id,
      mtime: 1000,
    })
  })

  it('applies a modify, a move and a delete from the feed, and downloads only the modify', async () => {
    const vault = await ownVault('incremental')
    const made = await commit(vault.client, [
      await createOp(vault.client, 'a.md', 'first a'),
      await createOp(vault.client, 'b.md', 'first b'),
      await createOp(vault.client, 'c.md', 'first c'),
    ])
    const [a, b, c] = made.results.map(applied)
    if (!a || !b || !c) throw new Error('the seed did not apply')

    const d = vault.device()
    await d.pull()
    d.forget()

    const second = await blob(vault.client, 'second a')
    await commit(vault.client, [
      { op: 'modify', file_id: a.file_id, base_version_id: a.version_id, ...second, mtime: 2000 },
      { op: 'move', file_id: b.file_id, base_version_id: b.version_id, to_path: 'notes/b.md' },
      { op: 'delete', file_id: c.file_id, base_version_id: c.version_id },
    ])

    const report = await d.pull()

    expect(report).toMatchObject({ applied: 3, skipped: 0, held: [], bootstrapped: false })
    expect(report.cursor).toBe(await headOf(vault))
    expect(await d.text('a.md')).toBe('second a')
    expect((await d.fs.stat('a.md'))?.mtime).toBe(2000)
    expect(await d.text('notes/b.md')).toBe('first b')
    expect(await d.fs.stat('b.md')).toBeNull()
    expect(await d.fs.stat('c.md')).toBeNull()
    expect(await d.state.get('b.md')).toBeNull()
    expect(await d.state.get('c.md')).toBeNull()
    expect(await d.state.byFileId(c.file_id)).toBeNull()
    expect(await d.state.byFileId(b.file_id)).toMatchObject({
      path: 'notes/b.md',
      sha: await shaOfText('first b'),
    })

    // The move carried the bytes the file already had, so only the modify went down the wire.
    expect(d.gets).toEqual([second.sha])
    expect(d.writes).toEqual(['a.md'])
  })

  it('holds a change on a path with a local edit, and applies it once on the pull after', async () => {
    const vault = await ownVault('holds')
    const made = await commit(vault.client, [
      await createOp(vault.client, 'a.md', 'first a'),
      await createOp(vault.client, 'b.md', 'first b'),
    ])
    const [a, b] = made.results.map(applied)
    if (!a || !b) throw new Error('the seed did not apply')

    const d = vault.device()
    await d.pull()
    d.forget()

    const nextA = await blob(vault.client, 'second a')
    const nextB = await blob(vault.client, 'second b')
    const later = await commit(vault.client, [
      { op: 'modify', file_id: a.file_id, base_version_id: a.version_id, ...nextA, mtime: 2000 },
      { op: 'modify', file_id: b.file_id, base_version_id: b.version_id, ...nextB, mtime: 2001 },
    ])
    const changedA = applied(later.results[0])

    const held = await d.pull({ dirty: new Set(['a.md']) })

    expect(held.applied).toBe(1)
    expect(held.held.map((change) => change.path)).toEqual(['a.md'])
    expect(held.held[0]).toMatchObject({ seq: changedA.seq, version_id: changedA.version_id })
    // The local edit is untouched, and the cursor stops just before the change it held.
    expect(await d.text('a.md')).toBe('first a')
    expect(await d.text('b.md')).toBe('second b')
    expect(held.cursor).toBe(changedA.seq - 1)
    expect(await d.state.getCursor()).toBe(changedA.seq - 1)
    expect(d.writes).toEqual(['b.md'])

    // The push settled: nothing is dirty, the held change comes round again and lands.
    const after = await d.pull()

    expect(after.applied).toBe(1)
    expect(after.held).toEqual([])
    // B's change is fetched a second time and recognised as one this device already has.
    expect(after.skipped).toBe(1)
    expect(after.cursor).toBe(await headOf(vault))
    expect(await d.text('a.md')).toBe('second a')
    expect(d.writes).toEqual(['b.md', 'a.md'])
    expect(d.gets).toEqual([nextB.sha, nextA.sha])
  })

  it('counts an excluded path as skipped and carries the cursor past it', async () => {
    const vault = await ownVault('excluded')
    await commit(vault.client, [await createOp(vault.client, 'a.md', 'first a')])

    const d = vault.device()
    await d.pull()
    d.forget()

    await commit(vault.client, [await createOp(vault.client, 'big/huge.bin', 'not for me')])
    const filter: ScanFilter = { excluded: (wirePath) => wirePath.startsWith('big/') }
    const report = await d.pull({ filter })

    expect(report).toMatchObject({ applied: 0, skipped: 1, held: [] })
    expect(report.cursor).toBe(await headOf(vault))
    expect(await d.state.getCursor()).toBe(report.cursor)
    expect(d.writes).toEqual([])
    expect(d.gets).toEqual([])
    expect(await d.fs.stat('big/huge.bin')).toBeNull()
  })

  it('downloads a page no wider than the concurrency it was given', async () => {
    const vault = await ownVault('pool')
    const ops: CommitOp[] = []
    for (let i = 0; i < 6; i++) ops.push(await createOp(vault.client, `f${i}.md`, `body ${i}`))
    await commit(vault.client, ops)

    const d = vault.device(3)
    const report = await d.pull({ concurrency: 2 })

    expect(report.applied).toBe(6)
    expect(d.gets).toHaveLength(6)
    expect(d.flight.peak).toBe(2)
  })

  it('holds no more downloaded bytes at once than its budget, a file bigger than it alone', async () => {
    const vault = await ownVault('budget')
    const size = 40_000
    const ops: CommitOp[] = []
    for (let i = 0; i < 10; i++) {
      ops.push(await createOp(vault.client, `big/${i}.bin`, String(i).repeat(size)))
    }
    // One larger than the whole budget: it still comes, on its own.
    ops.push(await createOp(vault.client, 'big/huge.bin', 'h'.repeat(150_000)))
    await commit(vault.client, ops)

    const d = vault.device()
    // Bytes downloaded and not yet written, at the moment of each write.
    let peak = 0
    const write = d.fs.writeAtomic.bind(d.fs)
    d.fs.writeAtomic = async (path, bytes, mtime) => {
      const held = d.gets.length - d.writes.length
      peak = Math.max(peak, held)
      await write(path, bytes, mtime)
    }
    const report = await d.pull({ prefetchBytes: 100_000 })
    expect(report.applied).toBe(11)
    expect(await d.text('big/huge.bin')).toBe('h'.repeat(150_000))
    // Two 40 kB files fit the 100 kB budget; a third would not.
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('reads a local file with the same sha rather than downloading it again', async () => {
    const vault = await ownVault('local bytes')
    await commit(vault.client, [await createOp(vault.client, 'a.md', 'the same bytes')])

    const d = vault.device()
    await d.pull()
    d.forget()

    // The very same content under a second path: the device already holds those bytes.
    await commit(vault.client, [await createOp(vault.client, 'copy.md', 'the same bytes', 3000)])
    const report = await d.pull()

    expect(report.applied).toBe(1)
    expect(d.gets).toEqual([])
    expect(d.writes).toEqual(['copy.md'])
    expect(await d.text('copy.md')).toBe('the same bytes')
    // Stat alone cannot authenticate bytes reused under the old sha: hash the read itself.
    expect(d.hashed.count).toBe(1)
  })

  it('tells the echo registry about every write it makes', async () => {
    const vault = await ownVault('echo')
    await commit(vault.client, [await createOp(vault.client, 'a.md', 'first a')])
    const sha = await shaOfText('first a')

    const d = vault.device()
    await d.pull()

    expect(d.expected.consume('a.md', sha)).toBe(true)
    // One `expect` per write: a second consume is a genuine edit that landed on those bytes.
    expect(d.expected.consume('a.md', sha)).toBe(false)
  })

  it('moves a file onto a clean local file of another id and takes that path over', async () => {
    const vault = await ownVault('replace')
    const made = await commit(vault.client, [
      await createOp(vault.client, 'a.md', 'from a'),
      await createOp(vault.client, 'b.md', 'from b'),
    ])
    const [a, b] = made.results.map(applied)
    if (!a || !b) throw new Error('the seed did not apply')

    const d = vault.device()
    await d.pull()
    d.forget()

    const gone = await commit(vault.client, [
      { op: 'delete', file_id: b.file_id, base_version_id: b.version_id },
    ])
    await commit(vault.client, [
      { op: 'move', file_id: a.file_id, base_version_id: a.version_id, to_path: 'b.md' },
    ])
    // This device never heard the delete: its cursor sits at that seq, the way it would
    // if that page had been applied and the feed then picked up where it left off.
    await d.state.setCursor(applied(gone.results[0]).seq)

    const report = await d.pull()

    expect(report.applied).toBe(1)
    expect(report.held).toEqual([])
    expect(await d.text('b.md')).toBe('from a')
    expect(await d.fs.stat('a.md')).toBeNull()
    expect(await d.state.get('b.md')).toMatchObject({
      fileId: a.file_id,
      sha: await shaOfText('from a'),
    })
    expect(await d.state.byFileId(b.file_id)).toBeNull()
    // The move carried its own bytes across; nothing came down the wire.
    expect(d.gets).toEqual([])
  })

  it('applies a rename that only changed the case of the path', async () => {
    const vault = await ownVault('case rename')
    const made = await commit(vault.client, [await createOp(vault.client, 'Note.md', 'a note')])
    const note = applied(made.results[0])

    const d = vault.device()
    await d.pull()
    d.forget()

    await commit(vault.client, [
      { op: 'move', file_id: note.file_id, base_version_id: note.version_id, to_path: 'note.md' },
    ])
    const report = await d.pull()

    expect(report.applied).toBe(1)
    expect(await d.text('note.md')).toBe('a note')
    expect(await d.fs.stat('Note.md')).toBeNull()
    expect(await d.state.get('note.md')).toMatchObject({ path: 'note.md', wirePath: 'note.md' })
    expect(await d.state.get('Note.md')).toBeNull()
    // A rename carries its own bytes, and the scan that follows has nothing to say: a device
    // that kept the old spelling would push the rename straight back and the two would loop.
    expect(d.gets).toEqual([])
    const scanned = await scan(d.fs, d.state, ALL)
    expect(scanned.ops).toEqual([])
    expect([...scanned.dirty]).toEqual([])
  })

  it('holds a case-only rename when the other spelling is a local file of its own', async () => {
    const vault = await ownVault('case twin')
    const made = await commit(vault.client, [await createOp(vault.client, 'Note.md', 'a note')])
    const note = applied(made.results[0])

    const d = vault.device()
    await d.pull()
    d.forget()

    // A case-sensitive disk, so these are two files. Only the disk can tell this apart from
    // the same file under two spellings, which is what a case-insensitive host would report.
    await d.fs.writeAtomic('note.md', encodeText('my own note'), 900)
    d.forget()

    await commit(vault.client, [
      { op: 'move', file_id: note.file_id, base_version_id: note.version_id, to_path: 'note.md' },
    ])
    const report = await d.pull()

    expect(report.applied).toBe(0)
    expect(report.held.map((change) => change.path)).toEqual(['note.md'])
    // Nothing was renamed over, and nothing threw: the move waits for the push to settle it.
    expect(await d.text('note.md')).toBe('my own note')
    expect(await d.text('Note.md')).toBe('a note')
    expect(await d.state.get('Note.md')).toMatchObject({ fileId: note.file_id })
    expect(d.writes).toEqual([])
    expect(d.gets).toEqual([])
  })

  it('leaves the cursor at 0 when the bootstrap itself held something', async () => {
    const vault = await ownVault('held bootstrap')
    await commit(vault.client, [
      await createOp(vault.client, 'a.md', 'first a'),
      await createOp(vault.client, 'b.md', 'first b'),
      await createOp(vault.client, 'c.md', 'first c'),
    ])

    const d = vault.device()
    // The third file, so a cursor wound back to `seq - 1` would not land on 0 by accident.
    const held = await d.pull({ dirty: new Set(['c.md']) })

    expect(held.bootstrapped).toBe(true)
    expect(held.applied).toBe(2)
    expect(held.held.map((change) => change.path)).toEqual(['c.md'])
    // Not `seq - 1`: a manifest item's seq is where that file last changed, and winding the
    // cursor back there would replay history. An unfinished walk says so by staying at 0.
    expect(held.cursor).toBe(0)
    expect(await d.state.getCursor()).toBe(0)
    d.forget()

    const after = await d.pull()

    expect(after.bootstrapped).toBe(true)
    expect(after.applied).toBe(1)
    expect(after.skipped).toBe(2)
    expect(after.cursor).toBe(await headOf(vault))
    expect(d.writes).toEqual(['c.md'])
    expect(await d.text('c.md')).toBe('first c')
  })

  it('bootstraps over a copy of the vault without downloading a single blob', async () => {
    const vault = await ownVault('copied vault')
    const bodies: Array<[string, string]> = [
      ['a.md', 'body of a'],
      ['b.md', 'body of b'],
      ['notes/c.md', 'body of c'],
    ]
    const ops: CommitOp[] = []
    for (const [path, body] of bodies) ops.push(await createOp(vault.client, path, body))
    await commit(vault.client, ops)

    const d = vault.device()
    // The disk this device starts on already holds the vault: a copy over a cable, a restore
    // from a backup, a second folder made by hand. Its mtimes are its own.
    for (const [path, body] of bodies) await d.fs.writeAtomic(path, encodeText(body), 500)
    d.forget()

    const report = await d.pull()

    expect(report.applied).toBe(3)
    expect(report.held).toEqual([])
    expect(d.gets).toEqual([])
    expect(d.writes).toEqual([])
    // Each copy is read and hashed once, to know it is the vault's; not a second time to file it.
    expect(d.hashed.count).toBe(3)
    expect(await d.text('notes/c.md')).toBe('body of c')
    // Adopted as they lie: the state carries the disk's own mtime, so the next scan is quiet.
    expect(await d.state.get('a.md')).toMatchObject({
      wirePath: 'a.md',
      sha: await shaOfText('body of a'),
      mtime: 500,
    })
    expect((await scan(d.fs, d.state, ALL)).ops).toEqual([])
  })

  it('holds an unsynced local file at the target without fetching what it is not', async () => {
    const vault = await ownVault('wrong copy')
    await commit(vault.client, [await createOp(vault.client, 'a.md', 'body of a')])

    const d = vault.device()
    // Not the vault's file: a note of this device's own, of another length, at that path.
    await d.fs.writeAtomic('a.md', encodeText('a much longer note of my own'), 900)
    d.forget()

    const report = await d.pull()

    expect(report.applied).toBe(0)
    expect(report.held.map((change) => change.path)).toEqual(['a.md'])
    expect(await d.text('a.md')).toBe('a much longer note of my own')
    // The apply was only ever going to adopt it or hold it, so nothing was worth fetching.
    expect(d.gets).toEqual([])
    expect(d.writes).toEqual([])
  })

  it.each([
    ['the same size', 'first a!', 'FIRST A!'],
    ['another size', 'first a!', 'first a! and more typed in'],
  ])(
    'leaves an edit that lands between its write and its stat for the scan to send (%s)',
    async (_, pulled, typed) => {
      const vault = await ownVault(`pull race ${typed.length}`)
      await commit(vault.client, [await createOp(vault.client, 'a.md', pulled, 1000)])
      const d = vault.device()
      // The person types into the file the moment the pull has written it, before the pull
      // has looked at what it wrote.
      const write = d.fs.writeAtomic.bind(d.fs)
      d.fs.writeAtomic = async (path, bytes, mtime) => {
        await write(path, bytes, mtime)
        if (path === 'a.md')
          await MemoryFileSystem.prototype.writeAtomic.call(d.fs, path, encodeText(typed), 5000)
      }

      await d.pull()

      expect(await d.text('a.md')).toBe(typed)
      const found = await scan(d.fs, d.state, ALL)
      expect(found.ops).toEqual([
        expect.objectContaining({ op: 'modify', sha: await shaOfText(typed) }),
      ])
    }
  )

  it('forgets the expectation for a write that failed', async () => {
    const vault = await ownVault('failed write')
    await commit(vault.client, [await createOp(vault.client, 'a.md', 'first a')])

    const d = vault.device()
    d.fails.write = (path) => path === 'a.md'

    await expect(d.pull()).rejects.toThrow('the disk refused a.md')
    // Nothing landed, so the watcher will never report it: an expectation left behind would
    // swallow the next genuine edit that happened to be those bytes.
    expect(d.expected.consume('a.md', await shaOfText('first a'))).toBe(false)
  })

  it('treats a move out of the synced set as a local delete', async () => {
    const vault = await ownVault('moved out')
    const made = await commit(vault.client, [await createOp(vault.client, 'a.md', 'first a')])
    const a = applied(made.results[0])

    const d = vault.device()
    await d.pull()
    d.forget()

    await commit(vault.client, [
      { op: 'move', file_id: a.file_id, base_version_id: a.version_id, to_path: 'big/a.md' },
    ])
    const filter: ScanFilter = { excluded: (wirePath) => wirePath.startsWith('big/') }
    const report = await d.pull({ filter })

    expect(report.applied).toBe(1)
    expect(report.skipped).toBe(0)
    expect(await d.fs.stat('a.md')).toBeNull()
    expect(await d.fs.stat('big/a.md')).toBeNull()
    expect(await d.state.byFileId(a.file_id)).toBeNull()
    expect(d.writes).toEqual([])
    expect(report.cursor).toBe(await headOf(vault))
    // The entry went with it, so the scan has no missing file to push back as a delete.
    expect((await scan(d.fs, d.state, filter)).ops).toEqual([])
  })

  it('counts a delete for a file it never had as skipped', async () => {
    const vault = await ownVault('unknown delete')
    const made = await commit(vault.client, [
      await createOp(vault.client, 'a.md', 'first a'),
      await createOp(vault.client, 'b.md', 'first b'),
    ])
    const b = applied(made.results[1])

    // This device did not sync `b.md` when it bootstrapped: the setting changed afterwards.
    const d = vault.device()
    await d.pull({ filter: { excluded: (wirePath) => wirePath === 'b.md' } })
    d.forget()

    await commit(vault.client, [
      { op: 'delete', file_id: b.file_id, base_version_id: b.version_id },
    ])
    const report = await d.pull()

    expect(report).toMatchObject({ applied: 0, skipped: 1, held: [] })
    expect(report.cursor).toBe(await headOf(vault))
  })

  it('stops fetching a page once a download has failed', async () => {
    const vault = await ownVault('failed page')
    const ops: CommitOp[] = []
    for (let i = 0; i < 8; i++) ops.push(await createOp(vault.client, `f${i}.md`, `body ${i}`))
    await commit(vault.client, ops)

    const d = vault.device()
    d.fails.get = (_sha, nth) => nth === 1

    await expect(d.pull({ concurrency: 2 })).rejects.toThrow(EngineError)
    // The pull throws the moment one worker does; the rest are still running, so wait for
    // them before counting. The other worker had already asked for one blob of its own;
    // nothing after those two was ever dispatched.
    await settle()
    expect(d.gets.length).toBeLessThanOrEqual(2)
    expect(d.writes).toEqual([])
  })

  it('writes the copy a conflict left beside the head', async () => {
    const vault = await ownVault('conflict')
    await copyConflictsAside(vault)
    const made = await commit(vault.client, [await createOp(vault.client, 'note.md', 'first')])
    const note = applied(made.results[0])

    const d = vault.device()
    await d.pull()
    d.forget()

    const winner = await blob(vault.client, 'theirs')
    await commit(vault.client, [
      {
        op: 'modify',
        file_id: note.file_id,
        base_version_id: note.version_id,
        ...winner,
        mtime: 2000,
      },
    ])
    const loser = await blob(vault.client, 'mine')
    const raced = await commit(vault.client, [
      {
        op: 'modify',
        file_id: note.file_id,
        base_version_id: note.version_id,
        ...loser,
        mtime: 2001,
      },
    ])
    const copy = conflicted(raced.results[0])

    const report = await d.pull()

    expect(report.applied).toBe(2)
    expect(report.held).toEqual([])
    expect(await d.text('note.md')).toBe('theirs')
    expect(await d.text(copy.conflict_path)).toBe('mine')
    expect(await d.state.get(copy.conflict_path)).toMatchObject({
      fileId: copy.conflict_file_id,
      versionId: copy.conflict_version_id,
      sha: loser.sha,
    })
    expect(report.cursor).toBe(await headOf(vault))
  })

  it('holds a change over a synced file whose stat says it was edited, with no dirty set at all', async () => {
    const vault = await ownVault('edited-unreported')
    const made = await commit(vault.client, [await createOp(vault.client, 'a.md', 'as synced')])
    const d = vault.device()
    await d.pull()
    const mine = applied(made.results[0])
    d.forget()

    // Another device edits the file; this one has typed into it, and no watcher said so.
    const theirs = await commit(vault.client, [
      {
        op: 'modify',
        file_id: mine.file_id,
        base_version_id: mine.version_id,
        ...(await blob(vault.client, 'as they have it')),
        mtime: 2000,
      },
    ])
    await d.fs.writeAtomic('a.md', encodeText('as I have it now'), 5000)
    d.forget()

    const report = await d.pull()

    expect(report.held.map((change) => change.path)).toEqual(['a.md'])
    expect(report.applied).toBe(0)
    expect(d.writes).toEqual([])
    expect(await d.text('a.md')).toBe('as I have it now')
    expect(await d.state.get('a.md')).toMatchObject({ versionId: mine.version_id, mtime: 1000 })
    expect(report.cursor).toBe(theirs.head_seq - 1)
  })

  it('writes through a touched file on the round after the push has repaired its entry', async () => {
    const vault = await ownVault('touched-unreported')
    const made = await commit(vault.client, [await createOp(vault.client, 'a.md', 'as synced')])
    const d = vault.device()
    await d.pull()
    const mine = applied(made.results[0])
    d.forget()

    const theirs = await commit(vault.client, [
      {
        op: 'modify',
        file_id: mine.file_id,
        base_version_id: mine.version_id,
        ...(await blob(vault.client, 'as they have it')),
        mtime: 2000,
      },
    ])
    // The same bytes under a later mtime: only a hash can tell, and the pull does not hash.
    await d.fs.writeAtomic('a.md', encodeText('as synced'), 7000)
    d.forget()

    const first = await d.pull()
    expect(first.held.map((change) => change.path)).toEqual(['a.md'])
    expect(d.writes).toEqual([])

    // The scan hashes it, finds nothing changed, and the push writes the new mtime down.
    const hash = async (bytes: Uint8Array): Promise<string> => sha256(bytes)
    const found = await scan(d.fs, d.state, ALL, { hash })
    expect(found.ops).toEqual([])
    await push(vault.client, d.fs, d.state, found, { expected: d.expected, hash })
    expect(await d.state.get('a.md')).toMatchObject({ mtime: 7000 })

    const second = await d.pull()
    expect(second.held).toEqual([])
    expect(second.applied).toBe(1)
    expect(d.writes).toEqual(['a.md'])
    expect(await d.text('a.md')).toBe('as they have it')
    expect(second.cursor).toBe(theirs.head_seq)
  })

  it('holds a move of a file with an unreported edit, and applies it once the edit has gone up', async () => {
    const vault = await ownVault('moved-while-edited')
    const made = await commit(vault.client, [await createOp(vault.client, 'a.md', 'as synced')])
    const d = vault.device()
    await d.pull()
    const mine = applied(made.results[0])
    d.forget()

    // Another device renames the file — the very same bytes under a new name — while this one
    // has typed into it, and no watcher said so.
    const moved = await commit(vault.client, [
      { op: 'move', file_id: mine.file_id, base_version_id: mine.version_id, to_path: 'b.md' },
    ])
    await d.fs.writeAtomic('a.md', encodeText('as synced, and then some'), 5000)
    d.forget()

    const first = await d.pull()

    expect(first.held.map((change) => change.path)).toEqual(['b.md'])
    expect(d.writes).toEqual([])
    expect(await d.fs.stat('b.md')).toBeNull()
    expect(await d.text('a.md')).toBe('as synced, and then some')
    expect(await d.state.get('a.md')).toMatchObject({ versionId: mine.version_id, mtime: 1000 })
    expect(first.cursor).toBe(moved.head_seq - 1)

    // The edit goes up as a modify of the old base; the server lands it where the head now is.
    const hash = async (bytes: Uint8Array): Promise<string> => sha256(bytes)
    const found = await scan(d.fs, d.state, ALL, { hash })
    expect(found.ops.map((op) => op.op)).toEqual(['modify'])
    const pushed = await push(vault.client, d.fs, d.state, found, { expected: d.expected, hash })
    expect(pushed.rejected).toEqual([])
    d.forget()

    const second = await d.pull()

    expect(second.held).toEqual([])
    expect(await d.fs.stat('a.md')).toBeNull()
    expect(await d.text('b.md')).toBe('as synced, and then some')
    expect(await d.state.get('b.md')).toMatchObject({
      fileId: mine.file_id,
      sha: await shaOfText('as synced, and then some'),
    })
    expect(second.cursor).toBe(await headOf(vault))
    expect(decoder.decode(await vault.client.getBlob(must(await d.state.get('b.md')).sha))).toBe(
      'as synced, and then some'
    )
  })
  it('holds a change whose bytes the server does not hash to what it named, and says so', async () => {
    const vault = await ownVault('lying-server')
    const made = await commit(vault.client, [
      await createOp(vault.client, 'honest.md', 'as named'),
      await createOp(vault.client, 'lied.md', 'as named too'),
    ])
    const lied = applied(made.results[1]).sha
    const client = h.clientFor(vault.deviceToken, vault.vaultId)
    const getBlob = client.getBlob.bind(client)
    let lying = true
    client.getBlob = async (sha) =>
      lying && sha === lied ? encodeText('something else entirely') : getBlob(sha)
    const d = deviceOn(client)
    const log: string[] = []

    const report = await d.pull({ log: (line) => log.push(line) })

    expect(report.applied).toBe(1)
    expect(report.held.map((change) => change.path)).toEqual(['lied.md'])
    expect(d.writes).toEqual(['honest.md'])
    expect(await d.state.get('lied.md')).toBeNull()
    expect(log.join('\n')).toContain(`bytes for ${lied} do not hash to it`)
    // Held, not skipped: a bootstrap that held something is not finished, and says so.
    expect(report.cursor).toBe(0)

    // The server comes clean; the next pull writes it and moves on.
    lying = false
    d.forget()
    const again = await d.pull()
    expect(again.held).toEqual([])
    expect(d.writes).toEqual(['lied.md'])
    expect(await d.text('lied.md')).toBe('as named too')
    expect(again.cursor).toBe(await headOf(vault))
  })

  it('holds a change when the disk has something other than a file in the way', async () => {
    const vault = await ownVault('in-the-way')
    const made = await commit(vault.client, [
      await createOp(vault.client, 'a.md', 'first a'),
      await createOp(vault.client, 'b.md', 'first b'),
    ])
    const d = vault.device()
    await d.pull()
    d.forget()
    const a = applied(made.results[0])
    const b = applied(made.results[1])
    const later = await commit(vault.client, [
      {
        op: 'modify',
        file_id: a.file_id,
        base_version_id: a.version_id,
        ...(await blob(vault.client, 'second a')),
        mtime: 2000,
      },
      { op: 'delete', file_id: b.file_id, base_version_id: b.version_id },
    ])
    // A folder has taken `a.md` and a link `b.md`: the adapter refuses both with `conflict`,
    // which is what the memory disk is made to say here.
    const write = d.fs.writeAtomic.bind(d.fs)
    d.fs.writeAtomic = async (path, bytes, mtime) => {
      if (path === 'a.md') throw new EngineError('conflict', 'a folder is at a.md')
      await write(path, bytes, mtime)
    }
    const remove = d.fs.remove.bind(d.fs)
    d.fs.remove = async (path) => {
      if (path === 'b.md') throw new EngineError('conflict', 'a link is at b.md')
      await remove(path)
    }
    const log: string[] = []

    const report = await d.pull({ log: (line) => log.push(line) })

    expect(report.held.map((change) => change.path).sort()).toEqual(['a.md', 'b.md'])
    expect(report.applied).toBe(0)
    expect(report.cursor).toBe(later.head_seq - 2)
    expect(await d.state.get('a.md')).toMatchObject({ versionId: a.version_id })
    expect(await d.state.get('b.md')).toMatchObject({ versionId: b.version_id })
    expect(log.join('\n')).toContain('a folder is at a.md')
    expect(log.join('\n')).toContain('a link is at b.md')

    // Once the disk is clear, the next pull finishes the job.
    d.fs.writeAtomic = write
    d.fs.remove = remove
    const again = await d.pull()
    expect(again.held).toEqual([])
    expect(again.applied).toBe(2)
    expect(await d.text('a.md')).toBe('second a')
    expect(await d.fs.stat('b.md')).toBeNull()
  })

  it('holds a rename whose new name a folder or a link has taken', async () => {
    const vault = await ownVault('rename-in-the-way')
    const made = await commit(vault.client, [await createOp(vault.client, 'a.md', 'first a')])
    const d = vault.device()
    await d.pull()
    d.forget()
    const a = applied(made.results[0])
    const later = await commit(vault.client, [
      { op: 'move', file_id: a.file_id, base_version_id: a.version_id, to_path: 'b.md' },
    ])
    // The user has made a folder called `b.md`: the adapter refuses the rename with `conflict`.
    const move = d.fs.move.bind(d.fs)
    d.fs.move = async (from, to) => {
      if (to === 'b.md') throw new EngineError('conflict', 'a folder is at b.md')
      await move(from, to)
    }
    const log: string[] = []

    const report = await d.pull({ log: (line) => log.push(line) })

    expect(report.held.map((change) => [change.op, change.path])).toEqual([['move', 'b.md']])
    expect(report.applied).toBe(0)
    expect(report.cursor).toBe(later.head_seq - 1)
    expect(await d.text('a.md')).toBe('first a')
    expect(await d.state.get('a.md')).toMatchObject({ versionId: a.version_id })
    expect(log.join('\n')).toContain('a folder is at b.md')

    d.fs.move = move
    const again = await d.pull()
    expect(again.held).toEqual([])
    expect(again.applied).toBe(1)
    expect(await d.fs.stat('a.md')).toBeNull()
    expect(await d.text('b.md')).toBe('first a')
  })
})
