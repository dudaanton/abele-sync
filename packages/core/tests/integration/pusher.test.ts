import {
  AbeleError,
  type CommitOp,
  type CommitOpResult,
  type CommitResponse,
} from '@abele/sync-protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  encodeText,
  EngineError,
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  pull,
  push,
  resumeJournal,
  scan,
  sha256,
  type Journal,
  type PullOptions,
  type PullReport,
  type PushOptions,
  type PushReport,
  type ScanFilter,
  type ScanResult,
  type VaultClient,
} from '../../src/index.js'
import { BASE_URL, serverHarness, type Harness } from '../helpers/harness.js'

/**
 * The pusher against a server in this process: every op it sends goes down the device
 * facet, every verdict it applies is one the real commit handed back, and every journal
 * it replays is answered by the real idempotency store.
 */

/** A device that syncs the whole vault. */
const ALL: ScanFilter = { excluded: () => false }

const decoder = new TextDecoder()

/** The name some text is filed under, for an assertion about what was sent or written. */
const shaOfText = (text: string): Promise<string> => sha256(encodeText(text))

/** Bytes under the name they hash to, uploaded so a seeding commit may name them. */
async function blob(client: VaultClient, text: string): Promise<{ sha: string; size: number }> {
  const bytes = encodeText(text)
  const sha = await sha256(bytes)
  await client.putBlob(sha, bytes)
  return { sha, size: bytes.length }
}

/** One seeding batch under a key no other batch in this file uses. */
let seeds = 0
const seed = (client: VaultClient, ops: CommitOp[]): Promise<CommitResponse> =>
  client.commit(ops, `pusher-seed-${++seeds}`)

/** One result, insisting the server applied it, so a test can name the version it made. */
function applied(
  result: CommitOpResult | undefined
): Extract<CommitOpResult, { status: 'applied' }> {
  if (result?.status !== 'applied') throw new Error(`not applied: ${JSON.stringify(result)}`)
  return result
}

function must<T>(value: T | null | undefined, why: string): T {
  if (value === null || value === undefined) throw new Error(why)
  return value
}

/**
 * A device: a disk, what it last synced, and a client whose blob traffic and commits are
 * counted. `puts`, `heads` and `commits` are what most of the assertions are really about
 * — that the pusher uploaded only what the vault lacked, and batched what it sent.
 */
interface Device {
  client: VaultClient
  fs: MemoryFileSystem
  state: MemoryStateStore
  expected: ExpectedWrites
  /** Every path `writeAtomic` was given, in order. */
  writes: string[]
  /** Every sha asked after, uploaded and downloaded, in order. */
  heads: string[]
  puts: string[]
  gets: string[]
  /** Every batch that reached `commitRaw`, with the key it was sent under. */
  commits: Array<{ ops: CommitOp[]; key: string }>
  /** How many uploads were ever in flight at once. */
  flight: { now: number; peak: number }
  /** How often anything hashed local bytes. */
  hashed: { count: number }
  /** The keys this device's pushes hand out, in order. */
  keys: string[]
  write(path: string, text: string, mtime?: number): Promise<void>
  text(path: string): Promise<string>
  scan(): Promise<ScanResult>
  /** Scan, then push what the scan found. */
  sync(over?: Partial<PushOptions>): Promise<PushReport>
  pushScan(result: ScanResult, over?: Partial<PushOptions>): Promise<PushReport>
  resume(over?: Partial<PushOptions>): Promise<PushReport | null>
  /** The puller, for the one test about what a push leaves for it to finish. */
  pull(over?: Partial<PullOptions>): Promise<PullReport>
  forget(): void
}

function deviceOn(
  client: VaultClient,
  name: string,
  delay = 0,
  fs = new MemoryFileSystem()
): Device {
  const state = new MemoryStateStore()
  const expected = new ExpectedWrites()
  const writes: string[] = []
  const heads: string[] = []
  const puts: string[] = []
  const gets: string[] = []
  const commits: Array<{ ops: CommitOp[]; key: string }> = []
  const flight = { now: 0, peak: 0 }
  const hashed = { count: 0 }
  const keys: string[] = []

  const write = fs.writeAtomic.bind(fs)
  fs.writeAtomic = async (path, bytes, mtime) => {
    writes.push(path)
    await write(path, bytes, mtime)
  }

  const hasBlob = client.hasBlob.bind(client)
  client.hasBlob = async (sha) => {
    heads.push(sha)
    return hasBlob(sha)
  }
  const putBlob = client.putBlob.bind(client)
  client.putBlob = async (sha, bytes) => {
    puts.push(sha)
    flight.now += 1
    flight.peak = Math.max(flight.peak, flight.now)
    try {
      // A few turns of the microtask queue, so overlapping uploads really do overlap.
      for (let tick = 0; tick < delay; tick++) await Promise.resolve()
      await putBlob(sha, bytes)
    } finally {
      flight.now -= 1
    }
  }
  const getBlob = client.getBlob.bind(client)
  client.getBlob = async (sha) => {
    gets.push(sha)
    return getBlob(sha)
  }
  const commitRaw = client.commitRaw.bind(client)
  client.commitRaw = async (ops, key) => {
    commits.push({ ops, key })
    return commitRaw(ops, key)
  }

  const hash = async (bytes: Uint8Array): Promise<string> => {
    hashed.count += 1
    return sha256(bytes)
  }
  const nextKey = (): string => {
    const key = `${name}-key-${keys.length + 1}`
    keys.push(key)
    return key
  }

  return {
    client,
    fs,
    state,
    expected,
    writes,
    heads,
    puts,
    gets,
    commits,
    flight,
    hashed,
    keys,
    // The device's own edits go straight in: `writes` is what the pusher wrote, and only that.
    write: (path, text, mtime = 1000) => write(path, encodeText(text), mtime),
    text: async (path) => decoder.decode(await fs.read(path)),
    scan: () => scan(fs, state, ALL, { hash }),
    sync: async (over = {}) =>
      push(client, fs, state, await scan(fs, state, ALL, { hash }), {
        expected,
        keys: nextKey,
        hash,
        ...over,
      }),
    pushScan: (result, over = {}) =>
      push(client, fs, state, result, { expected, keys: nextKey, hash, ...over }),
    resume: (over = {}) => resumeJournal(client, fs, state, { expected, hash, ...over }),
    pull: (over = {}) =>
      pull(client, fs, state, { filter: ALL, dirty: new Set(), expected, hash, ...over }),
    forget: () => {
      writes.length = 0
      heads.length = 0
      puts.length = 0
      gets.length = 0
      commits.length = 0
      flight.peak = 0
      hashed.count = 0
    },
  }
}

describe('the pusher over the device facet', () => {
  let h: Harness
  let accountToken: string

  interface Vault {
    vaultId: string
    deviceToken: string
    /** The client a test seeds the server with; its calls are never counted. */
    client: VaultClient
    device(name?: string, delay?: number, fs?: MemoryFileSystem): Device
  }

  /** A vault of its own, with a device enrolled on it, so no test disturbs another. */
  async function ownVault(name: string): Promise<Vault> {
    const { vaultId } = await h.vault(accountToken, name)
    const { deviceToken } = await h.device(accountToken, vaultId, `${name} device`)
    return {
      vaultId,
      deviceToken,
      client: h.clientFor(deviceToken, vaultId),
      device: (device = name, delay = 0, fs?: MemoryFileSystem) =>
        deviceOn(h.clientFor(deviceToken, vaultId), device, delay, fs),
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

  it('files the delete count in the same transaction as clearing the journal', async () => {
    const vault = await ownVault('durable-delete-count')
    const d = vault.device()
    await d.write('gone.md', 'gone')
    await d.sync()
    await d.fs.remove('gone.md')
    await expect(
      d.sync({
        onCommitted: async () => {
          await d.state.setMeta('sent-delete-count', '1')
          throw new Error('count could not be persisted')
        },
      })
    ).rejects.toThrow('count could not be persisted')
    expect(await d.state.getMeta('sent-delete-count')).toBeNull()
    expect(await d.state.getJournal()).not.toBeNull()
    await d.resume({ onCommitted: async () => d.state.setMeta('sent-delete-count', '1') })
    expect(await d.state.getMeta('sent-delete-count')).toBe('1')
    expect(await d.state.getJournal()).toBeNull()
  })

  beforeAll(async () => {
    h = await serverHarness()
    accountToken = (await h.account('pusher@abele.test')).accountToken
  })

  afterAll(async () => {
    await h.close()
  })

  it('commits a batch of creates and records the ids the server gave them', async () => {
    const vault = await ownVault('creates')
    const d = vault.device()
    await d.write('a.md', 'body of a', 1000)
    await d.write('notes/b.md', 'body of b', 1001)
    await d.write('c.txt', 'body of c', 1002)

    const report = await d.sync()

    expect(report).toMatchObject({ applied: 3, merged: 0, conflicts: 0, rejected: [], kept: [] })
    expect(report.replayed).toBe(false)
    expect(report.committed?.results).toHaveLength(3)
    expect(d.commits).toHaveLength(1)
    expect(d.commits[0]?.key).toBe(d.keys[0])
    expect(d.puts.sort()).toEqual(
      await Promise.all(['body of a', 'body of b', 'body of c'].map(shaOfText)).then((all) =>
        all.sort()
      )
    )

    const first = applied(report.committed?.results[0])
    expect(await d.state.get('a.md')).toEqual({
      path: 'a.md',
      wirePath: 'a.md',
      fileId: first.file_id,
      versionId: first.version_id,
      sha: await shaOfText('body of a'),
      size: 'body of a'.length,
      mtime: 1000,
    })
    expect(await d.state.byFileId(first.file_id)).toMatchObject({ path: 'a.md' })
    expect(await d.state.get('notes/b.md')).toMatchObject({ wirePath: 'notes/b.md' })
    expect(await d.state.getJournal()).toBeNull()

    // Everything is recorded, so a second scan has nothing to say and the push does nothing.
    const again = await d.sync()
    expect(again).toMatchObject({ committed: null, applied: 0, rejected: [] })
    expect(d.commits).toHaveLength(1)
  })

  it('records a move and a delete the server applied', async () => {
    const vault = await ownVault('moves')
    const d = vault.device()
    await d.write('a.md', 'body of a')
    await d.write('b.md', 'body of b')
    await d.sync()
    const kept = must(await d.state.get('a.md'), 'a.md was never synced')
    d.forget()

    await d.fs.move('a.md', 'notes/a.md')
    await d.fs.remove('b.md')

    const report = await d.sync()

    expect(report).toMatchObject({ applied: 2, merged: 0, conflicts: 0, rejected: [] })
    expect(d.puts).toEqual([])
    expect(await d.state.get('a.md')).toBeNull()
    expect(await d.state.get('b.md')).toBeNull()
    expect(await d.state.get('notes/a.md')).toMatchObject({
      wirePath: 'notes/a.md',
      fileId: kept.fileId,
      sha: kept.sha,
    })
    expect(await d.state.byFileId(kept.fileId)).toMatchObject({ path: 'notes/a.md' })

    const change = (await vault.client.changes(0)).items.filter((item) => item.op === 'move')
    expect(change).toHaveLength(1)
    expect(change[0]).toMatchObject({ path: 'notes/a.md', prev_path: 'a.md' })
  })

  it.each([
    ['a case-only rename', 'CaseTest.md', 'casetest.md'],
    ['a rename to another Unicode normalisation and case', 'Caf\u00e9.md', 'cafe\u0301.md'],
  ])('keeps the file through %s on a case-insensitive disk', async (_, from, to) => {
    const vault = await ownVault(`respell ${from}`)
    const d = vault.device('respell', 0, new MemoryFileSystem({ caseInsensitive: true }))
    await d.write(from, 'kept\n')
    await d.sync()
    const kept = must(await d.state.get(from), `${from} was never synced`)

    // On this disk `from` and `to` are the one file: the stat of the old name finds it too.
    await d.fs.move(from, to)
    const report = await d.sync()

    expect(report).toMatchObject({ applied: 1, rejected: [] })
    expect([...d.fs.snapshot().keys()]).toEqual([to])
    expect(await d.text(to)).toBe('kept\n')
    expect(await d.state.byFileId(kept.fileId)).toMatchObject({ path: to })

    // Nothing is left for the next scan to call gone.
    d.forget()
    expect(await d.sync()).toMatchObject({ committed: null })
    const items = (await vault.client.changes(0)).items
    expect(items.map((item) => item.op)).toEqual(['create', 'move'])
  })

  it('brings the merged bytes down when the server merged a stale edit', async () => {
    const vault = await ownVault('merge')
    const d = vault.device()
    await d.write('note.md', 'one\ntwo\nthree\n')
    await d.sync()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')
    d.forget()

    // Another device changes the first line while this one is away.
    const head = await blob(vault.client, 'ONE\ntwo\nthree\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])

    // This device changes the last line, from the base it still has.
    await d.write('note.md', 'one\ntwo\nTHREE\n', 3000)
    const report = await d.sync()

    expect(report).toMatchObject({ applied: 0, merged: 1, conflicts: 0, rejected: [] })
    const merged = report.committed?.results[0]
    if (merged?.status !== 'merged') throw new Error(`not merged: ${JSON.stringify(merged)}`)
    expect(await d.text('note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect(merged.sha).toBe(await shaOfText('ONE\ntwo\nTHREE\n'))
    expect(d.writes).toEqual(['note.md'])
    // The engine's own write, so the host's watcher does not push it straight back.
    expect(d.expected.consume('note.md', merged.sha)).toBe(true)
    expect(await d.state.get('note.md')).toMatchObject({
      fileId: base.fileId,
      versionId: merged.version_id,
      sha: merged.sha,
      mtime: merged.mtime,
    })
    expect(await d.state.getJournal()).toBeNull()

    // What is on disk is what was recorded, so the next scan has nothing to push.
    expect((await d.scan()).ops).toEqual([])
  })

  it('leaves an edit that lands between writing a merge and its stat for the next scan', async () => {
    const vault = await ownVault('merge race')
    const d = vault.device()
    await d.write('note.md', 'one\ntwo\nthree\n')
    await d.sync()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')
    const head = await blob(vault.client, 'ONE\ntwo\nthree\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    await d.write('note.md', 'one\ntwo\nTHREE\n', 3000)

    // The merge lands on disk, and the person types into it before the pusher looks again.
    const typed = 'ONE\ntwo\nTHREE\nfour\n'
    const write = d.fs.writeAtomic.bind(d.fs)
    d.fs.writeAtomic = async (path, bytes, mtime) => {
      await write(path, bytes, mtime)
      await MemoryFileSystem.prototype.writeAtomic.call(d.fs, path, encodeText(typed), 9000)
    }
    const report = await d.sync()

    expect(report).toMatchObject({ merged: 1, rejected: [] })
    expect(await d.text('note.md')).toBe(typed)
    expect((await d.scan()).ops).toEqual([
      expect.objectContaining({ op: 'modify', sha: await shaOfText(typed) }),
    ])
  })

  it('writes the head back when the vault copies conflicts aside', async () => {
    const vault = await ownVault('conflict')
    await copyConflictsAside(vault)
    const d = vault.device()
    await d.write('note.md', 'first')
    await d.sync()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')
    d.forget()

    const head = await blob(vault.client, 'theirs')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])

    await d.write('note.md', 'mine', 3000)
    const report = await d.sync()

    expect(report).toMatchObject({ applied: 0, merged: 0, conflicts: 1, rejected: [] })
    const copy = report.committed?.results[0]
    if (copy?.status !== 'conflict') throw new Error(`not a conflict: ${JSON.stringify(copy)}`)
    // The head is back at the path; the losing text is in the copy the next pull brings.
    expect(await d.text('note.md')).toBe('theirs')
    expect(d.writes).toEqual(['note.md'])
    expect(d.gets).toEqual([head.sha])
    expect(d.expected.consume('note.md', head.sha)).toBe(true)
    expect(await d.state.get('note.md')).toMatchObject({
      fileId: base.fileId,
      versionId: copy.version_id,
      sha: head.sha,
    })
    expect(await d.state.get(copy.conflict_path)).toBeNull()
    expect((await d.scan()).ops).toEqual([])
  })

  it('writes nothing when the head a conflict names is what the file already holds', async () => {
    const vault = await ownVault('conflict-same')
    await copyConflictsAside(vault)
    const d = vault.device()
    await d.write('note.md', 'first')
    await d.sync()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')
    d.forget()

    const head = await blob(vault.client, 'both of us')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])

    // This device typed the very same thing, from the base it still had.
    await d.write('note.md', 'both of us', 3000)
    const report = await d.sync()

    expect(report).toMatchObject({ conflicts: 1, rejected: [] })
    expect(await d.text('note.md')).toBe('both of us')
    // The bytes are already there: nothing was downloaded and nothing was written.
    expect(d.writes).toEqual([])
    expect(d.gets).toEqual([])
    expect(await d.state.get('note.md')).toMatchObject({ sha: head.sha, mtime: 3000 })
    expect((await d.scan()).ops).toEqual([])
  })

  it('puts a rejected move back where it was, and reports it', async () => {
    const vault = await ownVault('rejected')
    const d = vault.device()
    await d.write('x.md', 'body of x')
    await d.sync()
    const mine = must(await d.state.get('x.md'), 'x.md was never synced')
    d.forget()

    // Another device takes the name this one is about to rename onto.
    await seed(vault.client, [
      { op: 'create', path: 'taken.md', ...(await blob(vault.client, 'theirs')), mtime: 2000 },
    ])
    await d.fs.move('x.md', 'taken.md')

    const report = await d.sync()

    expect(report.applied).toBe(0)
    expect(report.rejected).toHaveLength(1)
    expect(report.rejected[0]).toMatchObject({ code: 'path_taken', op: { op: 'move' } })
    // The rename lost, so the file is back under the name the entry has for it, with the
    // stat the entry has for it: the next scan has nothing to send, and the next pull is
    // free to put the winner at the name it took.
    expect(await d.fs.stat('taken.md')).toBeNull()
    expect(await d.text('x.md')).toBe('body of x')
    expect(await d.fs.stat('x.md')).toMatchObject({ mtime: mine.mtime, size: mine.size })
    expect(await d.state.byFileId(mine.fileId)).toMatchObject({ path: 'x.md' })
    expect(await d.state.getJournal()).toBeNull()
    expect((await d.scan()).ops).toEqual([])
    await d.pull()
    expect(await d.text('taken.md')).toBe('theirs')
    expect(await d.text('x.md')).toBe('body of x')
  })

  it('leaves a rejected move where it is when the old name has been taken meanwhile', async () => {
    const vault = await ownVault('rejected-occupied')
    const d = vault.device()
    await d.write('x.md', 'body of x')
    await d.sync()
    d.forget()
    await seed(vault.client, [
      { op: 'create', path: 'taken.md', ...(await blob(vault.client, 'theirs')), mtime: 2000 },
    ])
    await d.fs.move('x.md', 'taken.md')
    // Something new under the old name, after the scan read the rename: putting the file
    // back would write over it.
    const found = await d.scan()
    await d.write('x.md', 'a new x', 3000)

    const report = await d.pushScan(found)

    expect(report.rejected.map((r) => r.code)).toEqual(['path_taken'])
    expect(await d.text('taken.md')).toBe('body of x')
    expect(await d.text('x.md')).toBe('a new x')
  })

  it('leaves a rejected move where it is when the file was edited after the scan', async () => {
    const vault = await ownVault('rejected-edited')
    const d = vault.device()
    await d.write('x.md', 'body of x')
    await d.sync()
    d.forget()
    await seed(vault.client, [
      { op: 'create', path: 'taken.md', ...(await blob(vault.client, 'theirs')), mtime: 2000 },
    ])
    await d.fs.move('x.md', 'taken.md')
    // Typed into after the scan read the rename: no longer the file the entry describes.
    const found = await d.scan()
    await d.write('taken.md', 'body of x, and more', 3000)
    const lines: string[] = []

    const report = await d.pushScan(found, { log: (line) => lines.push(line) })

    expect(report.rejected.map((r) => r.code)).toEqual(['path_taken'])
    expect(await d.text('taken.md')).toBe('body of x, and more')
    expect(await d.fs.stat('x.md')).toBeNull()
    expect(lines).toContain(
      'push: taken.md changed since the scan; the refused move is left as it is'
    )
  })

  it('drops the synced copy at the old path when a create lands on a file that had moved there', async () => {
    const vault = await ownVault('create-onto-moved')
    const d = vault.device()
    await d.write('a.md', 'from A\n', 1000)
    await d.sync()
    const mine = must(await d.state.get('a.md'), 'a.md was never synced')
    await d.pull()
    d.forget()

    // Another device renames the file onto the name this one is about to create under.
    await seed(vault.client, [
      { op: 'move', file_id: mine.fileId, base_version_id: mine.versionId, to_path: 'b.md' },
    ])
    await d.write('b.md', 'a new B\n', 2000)

    const report = await d.sync()

    // The server merged the create into the moved file; this disk had that file under its old
    // name, unedited, so the copy there goes: left, the next scan would create it anew.
    expect(report.merged).toBe(1)
    expect(await d.text('b.md')).toBe('from A\na new B\n')
    expect(await d.fs.stat('a.md')).toBeNull()
    expect(await d.state.get('a.md')).toBeNull()
    expect(await d.state.get('b.md')).toMatchObject({ fileId: mine.fileId })
    expect((await d.scan()).ops).toEqual([])
  })

  it('keeps an edited copy at the old path when a create lands on a file that had moved there', async () => {
    const vault = await ownVault('create-onto-moved-edited')
    const d = vault.device()
    await d.write('a.md', 'from A\n', 1000)
    await d.sync()
    const mine = must(await d.state.get('a.md'), 'a.md was never synced')
    await d.pull()
    d.forget()
    await seed(vault.client, [
      { op: 'move', file_id: mine.fileId, base_version_id: mine.versionId, to_path: 'b.md' },
    ])
    await d.write('b.md', 'a new B\n', 2000)
    // Typed into after the scan read it, so the copy at the old name is somebody's work.
    const found = await d.scan()
    await d.write('a.md', 'from A, and more\n', 3000)

    const report = await d.pushScan(found)

    expect(report.merged).toBe(1)
    expect(await d.text('a.md')).toBe('from A, and more\n')
    expect(await d.state.get('a.md')).toBeNull()
  })

  it('uploads only the shas the vault does not already name', async () => {
    const vault = await ownVault('uploads')
    const d = vault.device()
    await d.write('a.md', 'shared body')
    await d.sync()
    expect(d.puts).toEqual([await shaOfText('shared body')])
    d.forget()

    // The same bytes under another name: the vault names that sha already.
    await d.write('b.md', 'shared body')
    const report = await d.sync()

    expect(report.applied).toBe(1)
    expect(d.heads).toEqual([await shaOfText('shared body')])
    expect(d.puts).toEqual([])
  })

  it('uploads no more than the concurrency allows at once', async () => {
    const vault = await ownVault('flight')
    const d = vault.device('flight', 3)
    for (let i = 0; i < 6; i++) await d.write(`f${i}.md`, `body ${i}`, 1000 + i)

    await d.sync({ concurrency: 2 })

    expect(d.puts).toHaveLength(6)
    expect(d.flight.peak).toBe(2)
  })

  it('leaves the journal in place when the commit fails, and replays it under the same key', async () => {
    const vault = await ownVault('failed-commit')
    const d = vault.device()
    await d.write('a.md', 'body of a')

    const commitRaw = d.client.commitRaw.bind(d.client)
    let refuse = true
    d.client.commitRaw = async (ops, key) => {
      if (refuse) throw new AbeleError('rate_limited', 'not just now')
      return commitRaw(ops, key)
    }

    await expect(d.sync()).rejects.toThrow(AbeleError)

    const journal = must(await d.state.getJournal(), 'the failed commit left no journal')
    expect(journal.idempotencyKey).toBe(d.keys[0])
    expect(journal.ops).toEqual([
      { op: 'create', path: 'a.md', sha: await shaOfText('body of a'), size: 9, mtime: 1000 },
    ])
    expect(await d.state.get('a.md')).toBeNull()

    refuse = false
    const report = must(await d.resume(), 'the journal was not replayed')

    // The server never answered the first attempt, so this one is run rather than replayed.
    expect(report).toMatchObject({ applied: 1, merged: 0, conflicts: 0, rejected: [] })
    expect(report.replayed).toBe(false)
    expect(d.commits.at(-1)?.key).toBe(journal.idempotencyKey)
    expect(await d.state.get('a.md')).toMatchObject({ wirePath: 'a.md' })
    expect(await d.state.getJournal()).toBeNull()
  })

  it('replays the journal a crash left between the commit and the record', async () => {
    const vault = await ownVault('crash')
    const d = vault.device()
    await d.write('a.md', 'body of a', 1000)
    await d.write('b.md', 'body of b', 1001)

    // The commit lands, and the device dies before it can write down what came back.
    const transaction = d.state.transaction.bind(d.state)
    let crash = true
    d.state.transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (!crash) return transaction(fn)
      crash = false
      throw new EngineError('io', 'the state file went away')
    }

    await expect(d.sync()).rejects.toThrow(EngineError)
    const journal = must(await d.state.getJournal(), 'the crash left no journal')
    expect(journal.idempotencyKey).toBe(d.keys[0])
    expect(await d.state.get('a.md')).toBeNull()
    d.forget()

    const report = must(await d.resume(), 'the journal was not replayed')

    expect(report).toMatchObject({ applied: 2, merged: 0, conflicts: 0, rejected: [] })
    // The server had filed its answer: the batch was read back, not applied a second time.
    expect(report.replayed).toBe(true)
    expect(d.commits).toEqual([{ ops: journal.ops, key: journal.idempotencyKey }])
    expect(await d.state.getJournal()).toBeNull()

    const entry = must(await d.state.get('a.md'), 'the replay recorded nothing for a.md')
    expect(entry).toMatchObject({ wirePath: 'a.md', sha: await shaOfText('body of a') })
    // One commit, one version: the replay did not write the file twice.
    expect(await vault.client.versions(entry.fileId)).toHaveLength(1)
    expect((await vault.client.manifest(null)).items).toHaveLength(2)
    expect((await d.scan()).ops).toEqual([])
  })

  it('answers nothing when there is no journal to replay', async () => {
    const vault = await ownVault('no-journal')
    expect(await vault.device().resume()).toBeNull()
  })

  it('splits a long batch into commits of a thousand, and keeps a move with its modify', async () => {
    const vault = await ownVault('batches')
    const d = vault.device()
    await d.write('moved.md', 'before')
    await d.sync()
    const moved = must(await d.state.get('moved.md'), 'moved.md was never synced')
    d.forget()

    // 999 creates, then a move and the modify that belongs with it: 1 001 ops, whose
    // greedy thousandth boundary would fall between the move and its modify.
    const body = 'one body, many names'
    const bulk = await shaOfText(body)
    const edited = 'after'
    const ops: CommitOp[] = []
    const hashes = new Map<string, string>()
    const diskPaths = new Map<string, string>()
    for (let i = 0; i < 999; i++) {
      const path = `bulk/${String(i).padStart(3, '0')}.md`
      await d.write(path, body, 4000 + i)
      ops.push({ op: 'create', path, sha: bulk, size: body.length, mtime: 4000 + i })
      hashes.set(path, bulk)
      diskPaths.set(path, path)
    }
    await d.fs.remove('moved.md')
    await d.write('folder/moved.md', edited, 5000)
    ops.push({
      op: 'move',
      file_id: moved.fileId,
      base_version_id: moved.versionId,
      to_path: 'folder/moved.md',
    })
    ops.push({
      op: 'modify',
      file_id: moved.fileId,
      base_version_id: moved.versionId,
      sha: await shaOfText(edited),
      size: edited.length,
      mtime: 5000,
    })
    hashes.set('folder/moved.md', await shaOfText(edited))
    diskPaths.set('folder/moved.md', 'folder/moved.md')
    const batch: ScanResult = {
      ops,
      hashes,
      diskPaths,
      infos: new Map(),
      dirty: new Set([...hashes.keys(), 'moved.md']),
      skipped: [],
      collisions: [],
    }

    const report = await d.pushScan(batch)

    expect(report).toMatchObject({ applied: 1001, merged: 0, conflicts: 0, rejected: [] })
    expect(d.commits).toHaveLength(2)
    expect(d.commits[0]?.ops).toHaveLength(999)
    expect(d.commits[1]?.ops.map((op) => op.op)).toEqual(['move', 'modify'])
    // A key of its own for each batch, and each one the key its journal named.
    expect(new Set(d.commits.map((one) => one.key)).size).toBe(2)
    expect(await d.state.getJournal()).toBeNull()

    expect(await d.state.get('moved.md')).toBeNull()
    expect(await d.state.get('folder/moved.md')).toMatchObject({
      fileId: moved.fileId,
      sha: await shaOfText(edited),
      mtime: 5000,
    })
    expect(await d.state.get('bulk/998.md')).toMatchObject({ sha: bulk })
    // One sha for all 999 bodies, so only one upload however the batch was cut.
    expect(d.puts.filter((sha) => sha === bulk)).toHaveLength(1)
  })

  it('refreshes the mtime of a file whose content did not change', async () => {
    const vault = await ownVault('touched')
    const d = vault.device()
    await d.write('a.md', 'body of a', 1000)
    await d.sync()
    expect(await d.state.get('a.md')).toMatchObject({ mtime: 1000 })
    d.forget()

    // Touched, not edited: the same bytes under a later mtime.
    await d.write('a.md', 'body of a', 7000)
    const report = await d.sync()

    expect(report).toMatchObject({ committed: null, applied: 0, rejected: [] })
    expect(d.commits).toEqual([])
    // The scan had to hash it to find that out; the state now says so, so the next one does not.
    expect(d.hashed.count).toBe(1)
    expect(await d.state.get('a.md')).toMatchObject({
      sha: await shaOfText('body of a'),
      mtime: 7000,
    })

    d.forget()
    expect((await d.scan()).ops).toEqual([])
    expect(d.hashed.count).toBe(0)
  })

  it('files a touched file under the mtime the scan hashed, not one an edit since gave it', async () => {
    const vault = await ownVault('touched-then-edited')
    const d = vault.device()
    await d.write('a.md', 'body of a', 1000)
    await d.sync()
    d.forget()

    // Touched, not edited, when the scan reads it; edited by the time the push runs.
    await d.write('a.md', 'body of a', 7000)
    const found = await d.scan()
    await d.write('a.md', 'body of a, and then some', 8000)
    await d.pushScan(found)

    // The entry says what the scan saw, so the edit is a change the next scan finds and sends.
    expect(await d.state.get('a.md')).toMatchObject({
      sha: await shaOfText('body of a'),
      mtime: 7000,
    })
    const next = await d.scan()
    expect(next.ops.map((op) => op.op)).toEqual(['modify'])
    await d.pushScan(next)
    expect(await d.state.get('a.md')).toMatchObject({
      sha: await shaOfText('body of a, and then some'),
      mtime: 8000,
    })
  })

  it('writes the journal before it uploads anything', async () => {
    const vault = await ownVault('journal-first')
    const d = vault.device()
    await d.write('a.md', 'body of a')

    const seen: Array<Journal | null> = []
    const hasBlob = d.client.hasBlob.bind(d.client)
    d.client.hasBlob = async (sha) => {
      seen.push(await d.state.getJournal())
      return hasBlob(sha)
    }

    await d.sync()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ idempotencyKey: d.keys[0], ops: [{ op: 'create' }] })
    expect(seen[0]?.batchId).toEqual(expect.any(String))
    expect(seen[0]?.startedAt).toEqual(expect.any(String))
  })

  it('leaves an edit made while the batch was in the air alone, and keeps both sides after', async () => {
    const vault = await ownVault('merge-raced')
    const d = vault.device()
    await d.write('race.md', 'alfa\nbravo\ncharlie\n')
    await d.sync()
    const base = must(await d.state.get('race.md'), 'race.md was never synced')
    d.forget()

    // Another device rewrites the first line while this one is away.
    const head = await blob(vault.client, 'ALFA-from-yonder\nbravo\ncharlie\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    const sent = 'alfa\nbravo\nCHARLIE-from-here\n'
    const late = 'alfa\nbravo\nCHARLIE-from-here\ndelta-typed-late\n'
    await d.write('race.md', sent, 3000)

    // Somebody types again after the bytes have gone up and before the verdict comes back.
    const commitRaw = d.client.commitRaw.bind(d.client)
    let once = true
    d.client.commitRaw = async (ops, key) => {
      if (once) {
        once = false
        await d.write('race.md', late, 4000)
      }
      return commitRaw(ops, key)
    }

    const report = await d.sync()

    expect(report).toMatchObject({ merged: 1, rejected: [], kept: ['race.md'] })
    const merged = report.committed?.results[0]
    if (merged?.status !== 'merged') throw new Error(`not merged: ${JSON.stringify(merged)}`)
    // The typing is untouched, nothing was written, nothing was announced, and the merge the
    // device is never going to write was never downloaded either.
    expect(await d.text('race.md')).toBe(late)
    expect(d.writes).toEqual([])
    expect(d.gets).toEqual([])
    expect(d.expected.consume('race.md', merged.sha)).toBe(false)
    // The entry stays on the base the op was sent against, holding the bytes it sent.
    expect(await d.state.get('race.md')).toMatchObject({
      versionId: base.versionId,
      sha: await shaOfText(sent),
      size: sent.length,
      mtime: 3000,
    })
    expect((await d.scan()).ops).toEqual([
      {
        op: 'modify',
        file_id: base.fileId,
        base_version_id: base.versionId,
        sha: await shaOfText(late),
        size: late.length,
        mtime: 4000,
      },
    ])

    // The push after: the server holds that base, its own head and the late typing, and
    // merges all three, so neither device's line is lost.
    d.forget()
    const second = await d.sync()
    const again = second.committed?.results[0]
    if (again?.status !== 'merged') throw new Error(`not merged: ${JSON.stringify(again)}`)
    const settled = decoder.decode(await vault.client.getBlob(again.sha))
    expect(settled).toContain('ALFA-from-yonder')
    expect(settled).toContain('CHARLIE-from-here')
    expect(settled).toContain('delta-typed-late')
    expect(await d.text('race.md')).toBe(settled)
    expect((await d.scan()).ops).toEqual([])
  })

  it('leaves an edit made while the batch was in the air alone when the answer is a conflict', async () => {
    const vault = await ownVault('conflict-raced')
    await copyConflictsAside(vault)
    const d = vault.device()
    await d.write('race.md', 'echo-as-it-started')
    await d.sync()
    const base = must(await d.state.get('race.md'), 'race.md was never synced')
    d.forget()

    const head = await blob(vault.client, 'foxtrot-from-yonder')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    const sent = 'golf-from-here'
    const late = 'golf-from-here-and-then-some'
    await d.write('race.md', sent, 3000)

    const commitRaw = d.client.commitRaw.bind(d.client)
    let once = true
    d.client.commitRaw = async (ops, key) => {
      if (once) {
        once = false
        await d.write('race.md', late, 4000)
      }
      return commitRaw(ops, key)
    }

    const report = await d.sync()

    expect(report).toMatchObject({ conflicts: 1, rejected: [], kept: ['race.md'] })
    const copy = report.committed?.results[0]
    if (copy?.status !== 'conflict') throw new Error(`not a conflict: ${JSON.stringify(copy)}`)
    expect(await d.text('race.md')).toBe(late)
    expect(d.writes).toEqual([])
    expect(d.gets).toEqual([])
    expect(d.expected.consume('race.md', copy.sha)).toBe(false)
    expect(await d.state.get('race.md')).toMatchObject({
      versionId: base.versionId,
      sha: await shaOfText(sent),
      mtime: 3000,
    })
    // What was sent is already safe in the copy this conflict made.
    expect(
      decoder.decode(
        await vault.client.versionBytes(copy.conflict_file_id, copy.conflict_version_id)
      )
    ).toBe(sent)
    expect((await d.scan()).ops).toEqual([
      {
        op: 'modify',
        file_id: base.fileId,
        base_version_id: base.versionId,
        sha: await shaOfText(late),
        size: late.length,
        mtime: 4000,
      },
    ])

    // The push after: the head keeps the path — and lands on this disk, since nothing has
    // been typed since that scan — and the late text goes into a copy of its own.
    d.forget()
    const second = await d.sync()
    const again = second.committed?.results[0]
    if (again?.status !== 'conflict') throw new Error(`not a conflict: ${JSON.stringify(again)}`)
    expect(await d.text('race.md')).toBe('foxtrot-from-yonder')
    expect(decoder.decode(await vault.client.getBlob(again.sha))).toBe('foxtrot-from-yonder')
    expect(
      decoder.decode(
        await vault.client.versionBytes(again.conflict_file_id, again.conflict_version_id)
      )
    ).toBe(late)
  })

  it('writes the head a move carried across, so the file at the new path is already right', async () => {
    const vault = await ownVault('move-over-head')
    const d = vault.device()
    await d.write('x.md', 'the original text', 1000)
    await d.sync()
    const mine = must(await d.state.get('x.md'), 'x.md was never synced')
    // Level with the server, so the pull at the end has only what follows to walk.
    await d.pull()
    d.forget()

    // Another device edits it; this one never hears of that, and renames the file.
    const edited = await blob(vault.client, 'the text another device wrote')
    await seed(vault.client, [
      {
        op: 'modify',
        file_id: mine.fileId,
        base_version_id: mine.versionId,
        ...edited,
        mtime: 2000,
      },
    ])
    await d.fs.move('x.md', 'moved/x.md')

    const report = await d.sync()

    expect(report).toMatchObject({ applied: 1, merged: 0, conflicts: 0, rejected: [] })
    // The move went through against a base two versions old, carrying the head's blob to the
    // new path, and the result says which bytes that version holds.
    const moved = applied(report.committed?.results[0])
    expect(moved).toMatchObject({
      path: 'moved/x.md',
      sha: edited.sha,
      size: edited.size,
      mtime: 2000,
    })
    // They are not the bytes this disk had, so they are fetched once and written once, and
    // the write is announced like any other of the engine's own.
    expect(d.gets).toEqual([edited.sha])
    expect(d.writes).toEqual(['moved/x.md'])
    expect(d.expected.consume('moved/x.md', edited.sha)).toBe(true)
    expect(await d.text('moved/x.md')).toBe('the text another device wrote')
    expect(await d.state.get('moved/x.md')).toMatchObject({
      fileId: mine.fileId,
      versionId: moved.version_id,
      sha: edited.sha,
      size: edited.size,
      mtime: 2000,
    })
    // The entry and the disk agree, so a scan in the window before the pull says nothing.
    expect((await d.scan()).ops).toEqual([])
    d.forget()

    // The pull still walks the modify and the move it has not seen — the entry sits at the
    // move's version, so neither is passed over — but every byte is already where it belongs,
    // so it carries the file back to x.md and on again without fetching or writing anything.
    const pulled = await d.pull()

    expect(pulled.held).toEqual([])
    expect(d.gets).toEqual([])
    expect(d.writes).toEqual([])
    expect(await d.text('moved/x.md')).toBe('the text another device wrote')
    expect(await d.fs.stat('x.md')).toBeNull()
    expect((await d.scan()).ops).toEqual([])
  })

  it('writes the head a move carried across even when it is the same size at the same mtime', async () => {
    const vault = await ownVault('move-same-shape')
    const d = vault.device()
    await d.write('y.md', 'the original text', 1000)
    await d.sync()
    const mine = must(await d.state.get('y.md'), 'y.md was never synced')
    d.forget()

    // The same seventeen characters at the very mtime this device's file has: nothing but the
    // sha can tell the two apart, and the sha is what the decision now rests on.
    const twin = await blob(vault.client, 'yonder wrote this')
    expect(twin.size).toBe('the original text'.length)
    await seed(vault.client, [
      { op: 'modify', file_id: mine.fileId, base_version_id: mine.versionId, ...twin, mtime: 1000 },
    ])
    await d.fs.move('y.md', 'moved/y.md')

    const report = await d.sync()

    expect(report).toMatchObject({ applied: 1, merged: 0, conflicts: 0, rejected: [] })
    expect(applied(report.committed?.results[0]).sha).toBe(twin.sha)
    expect(d.gets).toEqual([twin.sha])
    expect(d.writes).toEqual(['moved/y.md'])
    expect(await d.text('moved/y.md')).toBe('yonder wrote this')
    expect(await d.state.get('moved/y.md')).toMatchObject({
      sha: twin.sha,
      size: twin.size,
      mtime: 1000,
    })
    expect((await d.scan()).ops).toEqual([])
  })

  it('leaves no entry when a create raced a create, so the next scan creates again', async () => {
    const vault = await ownVault('create-raced')
    const d = vault.device()

    // Another device got to that path first, with a file of its own.
    await seed(vault.client, [
      {
        op: 'create',
        path: 'both.md',
        ...(await blob(vault.client, 'line-from-yonder\n')),
        mtime: 2000,
      },
    ])

    const sent = 'line-from-here\n'
    const late = 'line-from-here\nlate-line-from-here\n'
    await d.write('both.md', sent, 3000)

    const commitRaw = d.client.commitRaw.bind(d.client)
    let once = true
    d.client.commitRaw = async (ops, key) => {
      if (once) {
        once = false
        await d.write('both.md', late, 4000)
      }
      return commitRaw(ops, key)
    }

    const first = await d.sync()

    expect(first).toMatchObject({ merged: 1, rejected: [], kept: ['both.md'] })
    expect(await d.text('both.md')).toBe(late)
    expect(d.writes).toEqual([])
    // A create has no base to keep it on, so nothing is recorded at all. That is what makes
    // the next scan a create of it again, which the server settles from an empty base against
    // whatever is at the path by then — so this device's text still gets its say.
    expect(await d.state.get('both.md')).toBeNull()
    expect((await d.scan()).ops).toEqual([
      { op: 'create', path: 'both.md', sha: await shaOfText(late), size: late.length, mtime: 4000 },
    ])

    d.forget()
    const second = await d.sync()

    const settled = second.committed?.results[0]
    if (settled?.status !== 'merged') throw new Error(`not merged: ${JSON.stringify(settled)}`)
    const server = decoder.decode(await vault.client.getBlob(settled.sha))
    expect(server).toContain('line-from-yonder')
    expect(server).toContain('late-line-from-here')
  })

  it('keeps every move with its modify, however far apart the scan put them', async () => {
    const vault = await ownVault('pairs')
    const d = vault.device()
    const many = 600
    for (let i = 0; i < many; i++)
      await d.write(`p/${String(i).padStart(3, '0')}.md`, 'before', 1000 + i)
    await d.sync()
    d.forget()

    // Every one of them renamed and edited: the scan emits 600 moves and then 600 modifies,
    // so a greedy thousandth boundary would fall among the modifies and orphan 500 moves.
    const after = 'after'
    const edited = await shaOfText(after)
    const moves: CommitOp[] = []
    const modifies: CommitOp[] = []
    const hashes = new Map<string, string>()
    const diskPaths = new Map<string, string>()
    for (let i = 0; i < many; i++) {
      const from = `p/${String(i).padStart(3, '0')}.md`
      const to = `q/${String(i).padStart(3, '0')}.md`
      const entry = must(await d.state.get(from), `${from} was never synced`)
      await d.fs.remove(from)
      await d.write(to, after, 5000 + i)
      moves.push({
        op: 'move',
        file_id: entry.fileId,
        base_version_id: entry.versionId,
        to_path: to,
      })
      modifies.push({
        op: 'modify',
        file_id: entry.fileId,
        base_version_id: entry.versionId,
        sha: edited,
        size: after.length,
        mtime: 5000 + i,
      })
      hashes.set(to, edited)
      diskPaths.set(to, to)
    }
    const ops = [...moves, ...modifies]

    const report = await d.pushScan({
      ops,
      hashes,
      infos: new Map(),
      diskPaths,
      dirty: new Set(hashes.keys()),
      skipped: [],
      collisions: [],
    })

    expect(report).toMatchObject({ applied: 1200, merged: 0, conflicts: 0, rejected: [] })
    expect(d.commits).toHaveLength(2)
    // Every move landed in the same commit as the modify that came with it.
    for (const commit of d.commits) {
      expect(commit.ops.length).toBeLessThanOrEqual(1000)
      const modified = new Set(commit.ops.flatMap((op) => (op.op === 'modify' ? [op.file_id] : [])))
      const orphans = commit.ops.filter((op) => op.op === 'move' && !modified.has(op.file_id))
      expect(orphans).toEqual([])
    }
    expect(await d.state.get('q/599.md')).toMatchObject({ sha: edited, mtime: 5599 })
    expect(await d.state.get('p/000.md')).toBeNull()
  })

  it('replays a journal it finds before it sends anything new', async () => {
    const vault = await ownVault('journal-first-then')
    const d = vault.device()
    await d.write('a.md', 'body of a')
    await d.sync()
    const landed = must(await d.state.get('a.md'), 'a.md was never synced')
    const key = must(d.keys[0], 'no key was handed out')
    const done = must(d.commits[0], 'nothing was committed')
    d.forget()

    // A journal the device never got round to clearing, for a batch that did land.
    await d.state.setJournal({
      batchId: 'left-behind',
      ops: done.ops,
      idempotencyKey: key,
      startedAt: new Date().toISOString(),
    })
    await d.write('b.md', 'body of b', 2000)

    const report = await d.sync()

    expect(d.commits).toHaveLength(2)
    // The journal went first, under its own key; the new work followed under a fresh one.
    expect(d.commits[0]).toMatchObject({ key, ops: done.ops })
    expect(d.commits[1]?.key).toBe(d.keys.at(-1))
    expect(d.commits[1]?.ops).toEqual([
      { op: 'create', path: 'b.md', sha: await shaOfText('body of b'), size: 9, mtime: 2000 },
    ])
    expect(report.replayed).toBe(true)
    expect(report.applied).toBe(2)
    expect(await d.state.getJournal()).toBeNull()
    // The replay was read back, not run: a.md is still on the one version it ever had.
    expect(await vault.client.versions(landed.fileId)).toHaveLength(1)
    expect(await d.state.get('b.md')).toMatchObject({ wirePath: 'b.md' })
  })

  it('finds the disk spelling of a wire path a replay has no scan for', async () => {
    const vault = await ownVault('spelling')
    const d = vault.device()
    // A disk that decomposes: the file is spelled NFD, the wire path is NFC.
    const disk = 'caf\u0065\u0301.md'
    const wire = 'caf\u00e9.md'
    await d.write(disk, 'body of a')

    const transaction = d.state.transaction.bind(d.state)
    let crash = true
    d.state.transaction = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (!crash) return transaction(fn)
      crash = false
      throw new EngineError('io', 'the state file went away')
    }
    await expect(d.sync()).rejects.toThrow(EngineError)
    const journal = must(await d.state.getJournal(), 'the crash left no journal')
    expect(journal.ops).toEqual([
      { op: 'create', path: wire, sha: await shaOfText('body of a'), size: 9, mtime: 1000 },
    ])

    const report = must(await d.resume(), 'the journal was not replayed')

    expect(report).toMatchObject({ applied: 1, rejected: [] })
    // The journal speaks the wire's NFC; what was recorded is the name the disk really uses.
    expect(await d.state.get(disk)).toMatchObject({ path: disk, wirePath: wire })
    expect(await d.state.get(wire)).toBeNull()
    expect((await d.scan()).ops).toEqual([])
  })

  it('writes a merge the server landed where the head had moved', async () => {
    const vault = await ownVault('merge-moved-head')
    const d = vault.device()
    await d.write('x.md', 'hotel\nindia\njuliet\n', 1000)
    await d.sync()
    const mine = must(await d.state.get('x.md'), 'x.md was never synced')
    await d.pull()
    d.forget()

    // Another device renames the file and rewrites its first line; this one hears of neither
    // and edits the last line from the base it still has.
    const theirs = await blob(vault.client, 'HOTEL-from-yonder\nindia\njuliet\n')
    const moved = await seed(vault.client, [
      { op: 'move', file_id: mine.fileId, base_version_id: mine.versionId, to_path: 'moved/x.md' },
    ])
    const afterMove = applied(moved.results[0])
    await seed(vault.client, [
      {
        op: 'modify',
        file_id: mine.fileId,
        base_version_id: afterMove.version_id,
        ...theirs,
        mtime: 2000,
      },
    ])
    await d.write('x.md', 'hotel\nindia\nJULIET-from-here\n', 3000)

    const report = await d.sync()

    expect(report).toMatchObject({ merged: 1, conflicts: 0, rejected: [], kept: [] })
    const merged = report.committed?.results[0]
    if (merged?.status !== 'merged') throw new Error(`not merged: ${JSON.stringify(merged)}`)
    expect(merged.path).toBe('moved/x.md')
    // The file this device had was untouched since the scan, only lying at its old path: the
    // merge is carried over and written there, not filed as somebody's typing and kept aside.
    expect(d.writes).toEqual(['moved/x.md'])
    expect(await d.fs.stat('x.md')).toBeNull()
    expect(await d.text('moved/x.md')).toBe('HOTEL-from-yonder\nindia\nJULIET-from-here\n')
    expect(await d.state.get('x.md')).toBeNull()
    expect(await d.state.get('moved/x.md')).toMatchObject({
      fileId: mine.fileId,
      versionId: merged.version_id,
      sha: merged.sha,
    })
    expect((await d.scan()).ops).toEqual([])
  })

  it('replays a batch whose files were written before the crash without pushing them again', async () => {
    const vault = await ownVault('replay-written')
    const d = vault.device()
    await d.write('note.md', 'kilo\nlima\nmike\n', 1000)
    await d.sync()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')
    d.forget()

    const head = await blob(vault.client, 'KILO-from-yonder\nlima\nmike\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    await d.write('note.md', 'kilo\nlima\nMIKE-from-here\n', 3000)

    // The merge comes back and is written to disk, and the device dies before the record
    // lands: the state rolls back to the journal, and the file keeps the merged bytes.
    const setJournal = d.state.setJournal.bind(d.state)
    let crash = true
    d.state.setJournal = async (journal) => {
      if (journal === null && crash) {
        crash = false
        throw new EngineError('io', 'the state file went away')
      }
      await setJournal(journal)
    }
    await expect(d.sync()).rejects.toThrow(EngineError)
    expect(d.writes).toEqual(['note.md'])
    expect(await d.text('note.md')).toBe('KILO-from-yonder\nlima\nMIKE-from-here\n')
    must(await d.state.getJournal(), 'the crash left no journal')
    expect(await d.state.get('note.md')).toMatchObject({ versionId: base.versionId })
    d.forget()

    const report = must(await d.resume(), 'the journal was not replayed')

    expect(report).toMatchObject({ merged: 1, rejected: [], kept: [] })
    expect(report.replayed).toBe(true)
    const merged = report.committed?.results[0]
    if (merged?.status !== 'merged') throw new Error(`not merged: ${JSON.stringify(merged)}`)
    // The file already holds the merge, so nothing is fetched, nothing is written, and it is
    // not mistaken for typing that happened while the batch was in the air.
    expect(d.gets).toEqual([])
    expect(d.writes).toEqual([])
    expect(await d.state.get('note.md')).toMatchObject({
      versionId: merged.version_id,
      sha: merged.sha,
    })
    expect(await d.state.getJournal()).toBeNull()
    // Nothing left to push: the merge is not sent up again as a change of its own.
    expect((await d.scan()).ops).toEqual([])
    // create, the other device's edit, the text sent here kept as itself, and the one merge.
    expect(await vault.client.versions(base.fileId)).toHaveLength(4)
  })
})
