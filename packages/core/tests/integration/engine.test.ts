import { AbeleError, type CommitOp } from '@abele/sync-protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTIVE,
  encodeText,
  EngineError,
  MemoryFileSystem,
  MemoryStateStore,
  sha256,
  SyncEngine,
  type ClientOptions,
  type EngineOptions,
  type EngineStatus,
  type VaultClient,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'

/** A `WebSocket` that never opens: every attempt is recorded and fails on the next turn. */
class ClosedDoor {
  static opens: number[] = []
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor() {
    ClosedDoor.opens.push(Date.now())
    setTimeout(() => {
      for (const listener of this.listeners.get('error') ?? []) listener({})
    }, 0)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  send(): void {}

  close(): void {}
}

/**
 * The engine against a server in this process: real commits, a real event socket, and the
 * memory adapters standing in for a disk and a state file. Every trigger the engine answers
 * to is pulled here — the socket, the watcher, the clock — and every state it reports.
 */

const decoder = new TextDecoder()

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(10)
  }
}

const shaOfText = (text: string): Promise<string> => sha256(encodeText(text))

/** Bytes under the name they hash to, uploaded so a seeding commit may name them. */
async function blob(client: VaultClient, text: string): Promise<{ sha: string; size: number }> {
  const bytes = encodeText(text)
  const sha = await sha256(bytes)
  await client.putBlob(sha, bytes)
  return { sha, size: bytes.length }
}

let seeds = 0
const seed = (client: VaultClient, ops: CommitOp[]): Promise<unknown> =>
  client.commit(ops, `engine-seed-${++seeds}`)

function must<T>(value: T | null | undefined, why: string): T {
  if (value === null || value === undefined) throw new Error(why)
  return value
}

/** A device: an engine over a memory disk and a memory state, with its server traffic counted. */
interface Device {
  engine: SyncEngine
  client: VaultClient
  fs: MemoryFileSystem
  state: MemoryStateStore
  commits: CommitOp[][]
  puts: string[]
  gets: string[]
  /** Every status the engine reported, in order. */
  statuses: EngineStatus[]
  /** How many syncs have started. */
  runs(): number
  write(path: string, text: string, mtime?: number): Promise<void>
  text(path: string): Promise<string>
}

describe('the engine over the device facet', () => {
  let h: Harness
  let accountToken: string
  const started: SyncEngine[] = []

  interface Vault {
    vaultId: string
    deviceToken: string
    deviceId: string
    /** A client a test seeds the server with; its traffic is nobody's. */
    client: VaultClient
    enrol(name: string): Promise<{ deviceId: string; deviceToken: string }>
  }

  async function ownVault(name: string): Promise<Vault> {
    const { vaultId } = await h.vault(accountToken, name)
    const { deviceId, deviceToken } = await h.device(accountToken, vaultId, `${name} device`)
    return {
      vaultId,
      deviceToken,
      deviceId,
      client: h.clientFor(deviceToken, vaultId),
      enrol: (device) => h.device(accountToken, vaultId, device),
    }
  }

  function deviceOn(
    client: VaultClient,
    over: Partial<EngineOptions> = {},
    fs = new MemoryFileSystem()
  ): Device {
    const state = new MemoryStateStore()
    const commits: CommitOp[][] = []
    const puts: string[] = []
    const gets: string[] = []
    const statuses: EngineStatus[] = []

    const commitRaw = client.commitRaw.bind(client)
    client.commitRaw = async (ops, key) => {
      commits.push(ops)
      return commitRaw(ops, key)
    }
    const putBlob = client.putBlob.bind(client)
    client.putBlob = async (sha, bytes) => {
      puts.push(sha)
      await putBlob(sha, bytes)
    }
    const getBlob = client.getBlob.bind(client)
    client.getBlob = async (sha) => {
      gets.push(sha)
      return getBlob(sha)
    }

    const engine = new SyncEngine({
      client,
      fs,
      state,
      selective: DEFAULT_SELECTIVE,
      debounceMs: 20,
      backoffMs: [50, 200],
      ...over,
    })
    engine.onStatus((status) => statuses.push(status))
    started.push(engine)

    return {
      engine,
      client,
      fs,
      state,
      commits,
      puts,
      gets,
      statuses,
      runs: () =>
        statuses.filter(
          (status, at) => status.state === 'syncing' && statuses[at - 1]?.state !== 'syncing'
        ).length,
      write: (path, text, mtime = 1000) => fs.writeAtomic(path, encodeText(text), mtime),
      text: async (path) => decoder.decode(await fs.read(path)),
    }
  }

  const device = (vault: Vault, over: Partial<EngineOptions> = {}, fs?: MemoryFileSystem): Device =>
    deviceOn(h.clientFor(vault.deviceToken, vault.vaultId), over, fs)

  /** Wait for an engine that is running on its own to settle at rest. */
  const settled = (d: Device, what: string): Promise<void> =>
    until(() => {
      const { state, lastSyncAt } = d.engine.status
      return state !== 'syncing' && lastSyncAt !== null
    }, what)

  beforeAll(async () => {
    h = await serverHarness()
    accountToken = (await h.account('engine@abele.test')).accountToken
  })

  afterEach(async () => {
    for (const engine of started.splice(0)) await engine.stop()
  })

  afterAll(async () => {
    await h.close()
  })

  it('pushes a local write to the server in one sync', async () => {
    const vault = await ownVault('local-write')
    const d = device(vault)
    await d.write('note.md', 'written here')

    const report = await d.engine.sync()

    expect(report.pull).toMatchObject({ applied: 0, held: [], bootstrapped: true })
    expect(report.push).toMatchObject({ applied: 1, rejected: [], kept: [] })
    expect(report.secondPull).not.toBeNull()
    expect(d.commits).toHaveLength(1)
    expect(d.puts).toEqual([await shaOfText('written here')])
    const manifest = await vault.client.manifest(null)
    expect(manifest.items.map((item) => item.path)).toEqual(['note.md'])
    expect(d.engine.status).toMatchObject({
      state: 'idle',
      pending: 0,
      lastError: null,
      cursor: manifest.head_seq,
      headSeq: manifest.head_seq,
    })
    expect(d.engine.status.lastSyncAt).toEqual(expect.any(String))
    // Level with the server, so a second sync has nothing to send and nothing to fetch.
    const again = await d.engine.sync()
    expect(again.push.committed).toBeNull()
    expect(again.secondPull).toBeNull()
    expect(d.commits).toHaveLength(1)
  })

  it('syncs on the seq frame a server commit sends, and ignores the echo of its own write', async () => {
    const vault = await ownVault('events')
    const d = device(vault)
    d.engine.start()
    await settled(d, 'the first sync')
    await until(() => h.hub.sockets(vault.vaultId) === 1, 'the server to take the hello')
    const before = d.runs()

    // Another device commits; the frame says so; the engine brings the file down.
    await seed(vault.client, [
      { op: 'create', path: 'live.md', ...(await blob(vault.client, 'from yonder')), mtime: 2000 },
    ])
    await until(() => d.fs.snapshot().has('live.md'), 'the file to arrive')
    await until(() => d.engine.status.state === 'idle', 'the engine to rest')
    expect(await d.text('live.md')).toBe('from yonder')
    expect(d.runs()).toBe(before + 1)
    expect(d.commits).toEqual([])

    // The host's watcher reports the write the engine just made: an echo, not a change.
    d.fs.emitChange(['live.md'])
    await wait(150)
    expect(d.runs()).toBe(before + 1)
    expect(d.commits).toEqual([])

    // A write of somebody else's: one sync, one commit, and nothing more after it.
    await d.write('mine.md', 'typed here', 3000)
    d.fs.emitChange(['mine.md'])
    await until(() => d.commits.length === 1, 'the commit')
    await until(() => d.engine.status.state === 'idle', 'the engine to rest')
    await wait(150)
    expect(d.runs()).toBe(before + 2)
    expect(d.commits).toHaveLength(1)
    expect((await vault.client.manifest(null)).items.map((item) => item.path)).toEqual([
      'live.md',
      'mine.md',
    ])
  })

  it('goes offline when the server cannot be reached, and comes back on the backoff', async () => {
    const vault = await ownVault('offline')
    let down = false
    let asked = 0
    const fetchOrNot: typeof fetch = async (input, init) => {
      asked += 1
      if (down) throw new TypeError('fetch failed')
      return h.fetch(input, init)
    }
    const d = deviceOn(h.clientFor(vault.deviceToken, vault.vaultId, { fetch: fetchOrNot }))
    await d.write('note.md', 'written while up')
    d.engine.start()
    await settled(d, 'the first sync')
    expect(d.commits).toHaveLength(1)

    down = true
    await d.write('later.md', 'written while down', 2000)
    d.fs.emitChange(['later.md'])
    await until(() => d.engine.status.state === 'offline', 'the engine to notice')
    expect(d.engine.status.lastError).toMatch(/never reached the server/)
    expect(d.commits).toHaveLength(1)

    // Retried on the backoff while it stays down; nothing else is touched.
    const before = asked
    await wait(120)
    expect(asked).toBeGreaterThan(before)
    expect(d.engine.status.state).toBe('offline')

    down = false
    await until(() => d.engine.status.state === 'idle', 'the engine to recover')
    expect(d.engine.status.lastError).toBeNull()
    expect(d.commits).toHaveLength(2)
    expect((await vault.client.manifest(null)).items.map((item) => item.path)).toEqual([
      'later.md',
      'note.md',
    ])
  })

  it('stops on a refused token until it is resumed with a good one', async () => {
    const vault = await ownVault('unauthorized')
    let token = vault.deviceToken
    let asked = 0
    // A transport that speaks whatever token the host holds now, as a host that re-enrols would.
    const fetchAs: typeof fetch = async (input, init) => {
      asked += 1
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${token}`)
      return h.fetch(input, { ...init, headers })
    }
    const extra: Partial<ClientOptions> = { fetch: fetchAs }
    const d = deviceOn(h.clientFor(vault.deviceToken, vault.vaultId, extra))
    await d.write('note.md', 'before the revocation')
    d.engine.start()
    await settled(d, 'the first sync')

    await h.clientOn(accountToken).revokeDevice(vault.deviceId)
    await d.write('after.md', 'after the revocation', 2000)
    d.fs.emitChange(['after.md'])
    await until(() => d.engine.status.state === 'error', 'the engine to give up')
    expect(d.engine.status.lastError).toMatch(/device token/)

    // No retry: the answer would be the same. The clock is stopped too.
    const before = asked
    await wait(250)
    expect(asked).toBe(before)
    expect(d.engine.status.state).toBe('error')
    await expect(d.engine.sync()).rejects.toThrow(AbeleError)

    token = (await vault.enrol('re-enrolled')).deviceToken
    d.engine.resume()
    await until(
      () => d.engine.status.state === 'idle' && d.engine.status.lastError === null,
      'the engine to recover'
    )
    const manifest = await h.clientFor(token, vault.vaultId).manifest(null)
    expect(manifest.items.map((item) => item.path)).toEqual(['after.md', 'note.md'])
  })

  it('resubscribes to events after start, stop, and start', async () => {
    const vault = await ownVault('restart-events')
    let notify: ((seq: number) => void) | null = null
    let subscriptions = 0
    const client = h.clientFor(vault.deviceToken, vault.vaultId)
    client.subscribe = (onSeq) => {
      subscriptions++
      notify = onSeq
      return () => {
        notify = null
      }
    }
    let completed!: () => void
    const nextSync = () =>
      new Promise<void>((resolve) => {
        completed = resolve
      })
    const d = deviceOn(client, { onSync: () => completed() })
    let done = nextSync()
    d.engine.start()
    await done
    await d.engine.stop()
    done = nextSync()
    d.engine.start()
    await done
    expect(subscriptions).toBe(2)
    expect(notify).not.toBeNull()
    const bytes = await blob(vault.client, 'written remotely')
    const remote = await vault.client.commit(
      [{ op: 'create', path: 'remote.md', ...bytes, mtime: 1 }],
      'restart-event'
    )
    done = nextSync()
    notify!(remote.head_seq)
    await done
    expect(await d.text('remote.md')).toBe('written remotely')
    expect(d.runs()).toBe(3)
  })

  it('stops after recording an in-flight commit without waiting on the next changes read', async () => {
    const vault = await ownVault('stop-after-commit')
    const d = device(vault)
    await d.write('note.md', 'keep the committed bytes')
    let entered!: () => void, releaseCommit!: () => void, releaseRead!: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve
    })
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const commit = d.client.commitRaw.bind(d.client)
    const changes = d.client.changes.bind(d.client)
    let committed = false,
      blockedReads = 0
    d.client.commitRaw = async (ops, key) => {
      entered()
      await commitGate
      const result = await commit(ops, key)
      committed = true
      return result
    }
    d.client.changes = async (...args) => {
      if (committed) {
        blockedReads++
        await readGate
      }
      return changes(...args)
    }
    const running = d.engine.sync()
    await reached
    const stopping = d.engine.stop()
    releaseCommit()
    // The ledger clearing the journal is the durable boundary. Let the run finish its
    // microtasks, but leave any subsequent server read blocked until after the assertion.
    let recorded!: () => void
    const filed = new Promise<void>((resolve) => {
      recorded = resolve
    })
    const journal = d.state.setJournal.bind(d.state)
    d.state.setJournal = async (value) => {
      await journal(value)
      if (value === null) recorded()
    }
    await filed
    const outcome = await Promise.race([
      stopping.then(() => 'stopped'),
      new Promise<string>((resolve) => setImmediate(() => resolve('pending'))),
    ])
    try {
      expect(outcome).toBe('stopped')
      expect(blockedReads).toBe(0)
      expect(await d.state.getJournal()).toBeNull()
      expect(await d.state.get('note.md')).toMatchObject({
        sha: await shaOfText('keep the committed bytes'),
      })
    } finally {
      releaseRead()
      await running
      await stopping
    }
  })

  it('waits for the running sync when stopped', async () => {
    const vault = await ownVault('stop')
    const d = device(vault)
    await d.write('note.md', 'on its way up')

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let gated = false
    const commitRaw = d.client.commitRaw.bind(d.client)
    d.client.commitRaw = async (ops, key) => {
      gated = true
      await gate
      return commitRaw(ops, key)
    }

    const running = d.engine.sync()
    await until(() => gated, 'the commit to be reached')
    let stopped = false
    const stopping = d.engine.stop().then(() => {
      stopped = true
    })
    await wait(30)
    expect(stopped).toBe(false)
    expect(d.engine.status.state).toBe('syncing')

    release()
    await stopping
    expect(stopped).toBe(true)
    const report = await running
    expect(report.push.applied).toBe(1)
    expect(d.engine.status.state).toBe('idle')
    expect((await vault.client.manifest(null)).items.map((item) => item.path)).toEqual(['note.md'])
  })

  it('unites a folder with a vault on the first sync, linking equal content without an upload', async () => {
    const vault = await ownVault('first-sync')
    await seed(vault.client, [
      { op: 'create', path: 'a.md', ...(await blob(vault.client, 'the same on both')), mtime: 100 },
      {
        op: 'create',
        path: 'b.md',
        ...(await blob(vault.client, 'only in the vault')),
        mtime: 200,
      },
    ])
    const d = device(vault)
    await d.write('a.md', 'the same on both', 5000)
    await d.write('c.md', 'only in the folder', 6000)

    const report = await d.engine.sync()

    expect(report.pull).toMatchObject({ bootstrapped: true, held: [] })
    expect(report.push).toMatchObject({ applied: 1, rejected: [] })
    expect([...d.fs.snapshot().keys()].sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect(await d.text('b.md')).toBe('only in the vault')
    expect((await vault.client.manifest(null)).items.map((item) => item.path)).toEqual([
      'a.md',
      'b.md',
      'c.md',
    ])
    // a.md was adopted where it lay: never downloaded, never uploaded, its own mtime kept.
    expect(d.gets).toEqual([await shaOfText('only in the vault')])
    expect(d.puts).toEqual([await shaOfText('only in the folder')])
    expect(await d.state.get('a.md')).toMatchObject({
      sha: await shaOfText('the same on both'),
      mtime: 5000,
    })
    expect(d.commits).toHaveLength(1)
    expect(d.commits[0]).toEqual([
      {
        op: 'create',
        path: 'c.md',
        sha: await shaOfText('only in the folder'),
        size: 'only in the folder'.length,
        mtime: 6000,
      },
    ])
  })

  it('brings two devices to the same merged note through syncs alone', async () => {
    const vault = await ownVault('two-devices')
    const a = device(vault)
    const b = device(vault)
    await a.write('note.md', 'one\ntwo\nthree\n', 1000)
    await a.engine.sync()
    await b.engine.sync()
    expect(await b.text('note.md')).toBe('one\ntwo\nthree\n')

    // Each edits a different line of the version they share.
    await a.write('note.md', 'ONE\ntwo\nthree\n', 2000)
    await b.write('note.md', 'one\ntwo\nTHREE\n', 3000)
    await a.engine.sync()
    const merged = await b.engine.sync()
    expect(merged.push.merged).toBe(1)
    await a.engine.sync()

    expect(await a.text('note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect(await b.text('note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect(a.fs.snapshot()).toEqual(b.fs.snapshot())
    const entry = must(await a.state.get('note.md'), 'a never synced note.md')
    expect(await b.state.get('note.md')).toMatchObject({
      fileId: entry.fileId,
      versionId: entry.versionId,
    })
    // Nothing left to say on either side.
    expect((await a.engine.sync()).push.committed).toBeNull()
    expect((await b.engine.sync()).push.committed).toBeNull()
  })

  it('keeps a stale verdict clear of the next pull, so late typing is merged rather than overwritten', async () => {
    const vault = await ownVault('kept')
    const d = device(vault)
    await d.write('race.md', 'alfa\nbravo\ncharlie\n', 1000)
    // Started, so the watcher is on and the engine trusts it about what changed on disk;
    // then paused, so nothing runs but the syncs this test asks for.
    d.engine.start()
    await settled(d, 'the first sync')
    d.engine.pause()
    expect(d.engine.status.state).toBe('paused')
    const base = must(await d.state.get('race.md'), 'race.md was never synced')

    // Another device rewrites the first line while this one is away.
    const head = await blob(vault.client, 'ALFA-from-yonder\nbravo\ncharlie\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    const sent = 'alfa\nbravo\nCHARLIE-from-here\n'
    const late = 'alfa\nbravo\nCHARLIE-from-here\ndelta-typed-late\n'
    // Reported to the engine, as the host's watcher would, so the pull keeps clear of it.
    await d.write('race.md', sent, 3000)
    d.fs.emitChange(['race.md'])
    await wait(50)

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

    const first = await d.engine.sync()

    expect(first.push).toMatchObject({ merged: 1, kept: ['race.md'] })
    expect(await d.text('race.md')).toBe(late)
    // The first pull held the other device's edit, since the watcher had reported the file;
    // the pull after the push held the merge the server made, since the path was kept — the
    // other device's edit, superseded by that merge on the same page, only moved the cursor.
    expect(first.pull.held.map((c) => c.path)).toEqual(['race.md'])
    const afterPush = must(first.secondPull, 'no pull after the push')
    expect(afterPush.held.map((c) => [c.path, c.op])).toEqual([['race.md', 'merge']])
    expect(d.engine.status).toMatchObject({ state: 'paused', pending: 1 })

    const writes: Array<[string, string]> = []
    const write = d.fs.writeAtomic.bind(d.fs)
    d.fs.writeAtomic = async (path, bytes, mtime) => {
      writes.push([path, decoder.decode(bytes)])
      await write(path, bytes, mtime)
    }

    const second = await d.engine.sync()

    // The next run's first pull is told the same, so the late typing is still there for the
    // scan, and goes up as a modify of the old base; the server merges all three.
    expect(second.pull.held.map((c) => c.path)).toEqual(['race.md'])
    expect(second.push).toMatchObject({ merged: 1, kept: [] })
    const settledText = await d.text('race.md')
    expect(settledText).toContain('ALFA-from-yonder')
    expect(settledText).toContain('CHARLIE-from-here')
    expect(settledText).toContain('delta-typed-late')
    expect(second.secondPull?.held).toEqual([])
    expect(d.engine.status).toMatchObject({ state: 'paused', pending: 0 })
    // One write, of the merged text: the pull after the push found the versions it had held
    // superseded by the one the push recorded, and wrote none of them back over it.
    expect(writes).toEqual([['race.md', settledText]])
    expect((await d.engine.sync()).push.committed).toBeNull()
  })

  it('reports any other failure as an error and tries again on the next trigger', async () => {
    const vault = await ownVault('error')
    const d = device(vault)
    await d.write('note.md', 'body')
    const commitRaw = d.client.commitRaw.bind(d.client)
    let refuse = true
    d.client.commitRaw = async (ops, key) => {
      if (refuse) throw new EngineError('io', 'the disk is full')
      return commitRaw(ops, key)
    }

    await expect(d.engine.sync()).rejects.toThrow('the disk is full')
    expect(d.engine.status).toMatchObject({
      state: 'error',
      lastError: 'the disk is full',
      pending: 1,
    })

    refuse = false
    const report = await d.engine.sync()
    // The journal the failure left was replayed first, under its own key.
    expect(report.push).toMatchObject({ applied: 1, rejected: [] })
    expect(d.engine.status).toMatchObject({ state: 'idle', lastError: null, pending: 0 })
  })

  it('backs the socket off on its own when it cannot open, and does not sync for trying', async () => {
    const vault = await ownVault('closed-door')
    ClosedDoor.opens = []
    const client = h.clientFor(vault.deviceToken, vault.vaultId, {
      WebSocket: ClosedDoor as unknown as typeof WebSocket,
    })
    const d = deviceOn(client, { backoffMs: [10, 40], fallbackMs: 10_000 })
    d.engine.start()
    await settled(d, 'the first sync')
    const runs = d.runs()

    await wait(180)

    // Opened at once, then after 10, 20, 40 and 40 ms: five or six tries, not eighteen.
    const opens = ClosedDoor.opens
    expect(opens.length).toBeGreaterThanOrEqual(4)
    expect(opens.length).toBeLessThanOrEqual(6)
    const gaps = opens.slice(1).map((at, i) => at - must(opens[i], 'no earlier open'))
    expect(gaps[0]).toBeGreaterThanOrEqual(8)
    expect(gaps[1]).toBeGreaterThanOrEqual(18)
    expect(gaps[2]).toBeGreaterThanOrEqual(38)
    if (gaps[3] !== undefined) expect(gaps[3]).toBeGreaterThanOrEqual(38)
    // Not one sync for all that trying, and the HTTP side was never in doubt.
    expect(d.runs()).toBe(runs)
    expect(d.commits).toEqual([])
    expect(d.engine.status.state).toBe('idle')
  })

  it('keeps syncing on the clock while the socket stays shut', async () => {
    const vault = await ownVault('closed-door-clock')
    ClosedDoor.opens = []
    const client = h.clientFor(vault.deviceToken, vault.vaultId, {
      WebSocket: ClosedDoor as unknown as typeof WebSocket,
    })
    const d = deviceOn(client, { backoffMs: [10, 40], fallbackMs: 40 })
    d.engine.start()
    await settled(d, 'the first sync')

    await wait(200)

    // The clock ticked every 40 ms or so; the socket's failures added nothing to that.
    expect(d.runs()).toBeGreaterThanOrEqual(3)
    expect(d.runs()).toBeLessThanOrEqual(7)
    expect(ClosedDoor.opens.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps a refused op clear of the pulls after it, so the typing is sent again and merged', async () => {
    const vault = await ownVault('rejected')
    const d = device(vault)
    await d.write('race.md', 'alfa\nbravo\ncharlie\n', 1000)
    d.engine.start()
    await settled(d, 'the first sync')
    d.engine.pause()
    const base = must(await d.state.get('race.md'), 'race.md was never synced')

    const head = await blob(vault.client, 'ALFA-from-yonder\nbravo\ncharlie\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    const e1 = 'alfa\nbravo\nCHARLIE-first-typing\n'
    const e2 = 'alfa\nbravo\nCHARLIE-first-typing\nsecond-typing\n'
    await d.write('race.md', e1, 3000)
    d.fs.emitChange(['race.md'])
    await wait(50)

    // Typed again between the scan and the upload: the bytes that go up are not the sha the
    // op named, so the server refuses the op, and the file is left exactly as it is.
    const hasBlob = d.client.hasBlob.bind(d.client)
    let once = true
    d.client.hasBlob = async (sha) => {
      if (once) {
        once = false
        await d.write('race.md', e2, 4000)
      }
      return hasBlob(sha)
    }

    const first = await d.engine.sync()

    expect(first.push.rejected.map((r) => r.code)).toEqual(['not_found'])
    expect(first.push).toMatchObject({ applied: 0, merged: 0, kept: [] })
    expect(await d.text('race.md')).toBe(e2)
    // The other device's edit was held before the push and again after it.
    expect(first.pull.held.map((c) => c.path)).toEqual(['race.md'])
    expect(must(first.secondPull, 'no pull after the push').held.map((c) => c.path)).toEqual([
      'race.md',
    ])
    expect(d.engine.status.pending).toBe(1)

    const second = await d.engine.sync()

    expect(second.pull.held.map((c) => c.path)).toEqual(['race.md'])
    expect(second.push).toMatchObject({ merged: 1, rejected: [] })
    const settledText = await d.text('race.md')
    expect(settledText).toContain('ALFA-from-yonder')
    expect(settledText).toContain('CHARLIE-first-typing')
    expect(settledText).toContain('second-typing')
    expect(d.engine.status.pending).toBe(0)
  })

  it('does not write over an edit made while it was stopped', async () => {
    const vault = await ownVault('stopped-edit')
    const d = device(vault)
    await d.write('note.md', 'one\ntwo\nthree\n', 1000)
    d.engine.start()
    await settled(d, 'the first sync')
    await d.engine.stop()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')

    // Both sides edit while this engine is down; the local one has no watcher to report it.
    const head = await blob(vault.client, 'ONE\ntwo\nthree\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    await d.write('note.md', 'one\ntwo\nTHREE\n', 3000)

    d.engine.start()
    await until(() => d.commits.length === 1, 'the local edit to go up')
    await until(() => d.engine.status.state === 'idle', 'the engine to rest')

    expect(await d.text('note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect(
      decoder.decode(await vault.client.getBlob(must(await d.state.get('note.md'), 'gone').sha))
    ).toBe('ONE\ntwo\nTHREE\n')
  })

  it('does not write over an edit its watcher never reported', async () => {
    const vault = await ownVault('unreported-edit')
    const d = device(vault)
    await d.write('note.md', 'one\ntwo\nthree\n', 1000)
    d.engine.start()
    await settled(d, 'the first sync')
    d.engine.pause()
    const base = must(await d.state.get('note.md'), 'note.md was never synced')

    const head = await blob(vault.client, 'ONE\ntwo\nthree\n')
    await seed(vault.client, [
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...head, mtime: 2000 },
    ])
    // Written, and the host says nothing about it.
    await d.write('note.md', 'one\ntwo\nTHREE\n', 3000)

    const report = await d.engine.sync()

    // The first pull held it on the strength of the file's own stat, and the push merged it.
    expect(report.pull.held.map((c) => c.path)).toEqual(['note.md'])
    expect(report.push.merged).toBe(1)
    expect(await d.text('note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect((await d.engine.sync()).push.committed).toBeNull()
  })

  it('walks the manifest again on rescan, and writes nothing it already has', async () => {
    const vault = await ownVault('rescan')
    await seed(vault.client, [
      { op: 'create', path: 'a.md', ...(await blob(vault.client, 'already here')), mtime: 100 },
    ])
    const d = device(vault)
    await d.write('b.md', 'from this device')
    await d.engine.sync()
    const writes: string[] = []
    const write = d.fs.writeAtomic.bind(d.fs)
    d.fs.writeAtomic = async (path, bytes, mtime) => {
      writes.push(path)
      await write(path, bytes, mtime)
    }
    const gets = d.gets.length
    const commits = d.commits.length
    const head = d.engine.status.cursor

    const report = await d.engine.rescan()

    // The manifest was walked from the start; every file on it is known by its version.
    expect(report.pull).toMatchObject({ bootstrapped: true, applied: 0, held: [], skipped: 2 })
    expect(report.push.committed).toBeNull()
    expect(writes).toEqual([])
    expect(d.gets).toHaveLength(gets)
    expect(d.commits).toHaveLength(commits)
    expect(d.engine.status).toMatchObject({ state: 'idle', cursor: head, pending: 0 })
    expect(await d.state.getCursor()).toBe(head)
  })

  it('does not lose an unreported edit to a server move of the same file', async () => {
    const vault = await ownVault('moved-while-edited')
    const d = device(vault)
    await d.write('a.md', 'as synced', 1000)
    d.engine.start()
    await settled(d, 'the first sync')
    d.engine.pause()
    const base = must(await d.state.get('a.md'), 'a.md was never synced')

    await seed(vault.client, [
      { op: 'move', file_id: base.fileId, base_version_id: base.versionId, to_path: 'b.md' },
    ])
    // Written, and the host says nothing about it.
    await d.write('a.md', 'as synced, and then some', 3000)

    const first = await d.engine.sync()
    expect(first.pull.held.map((c) => c.path)).toEqual(['b.md'])
    expect(first.push).toMatchObject({ applied: 1, rejected: [] })
    const second = await d.engine.sync()
    expect(second.push.committed).toBeNull()

    expect(await d.fs.stat('a.md')).toBeNull()
    expect(await d.text('b.md')).toBe('as synced, and then some')
    const entry = must(await d.state.get('b.md'), 'b.md was never recorded')
    expect(decoder.decode(await vault.client.getBlob(entry.sha))).toBe('as synced, and then some')
    expect((await vault.client.manifest(null)).items.map((item) => item.path)).toEqual(['b.md'])
  })
  it('clears a journal the server refuses as a whole, and syncs on without it', async () => {
    const vault = await ownVault('poisoned-journal')
    await seed(vault.client, [
      { op: 'create', path: 'theirs.md', ...(await blob(vault.client, 'from yonder')), mtime: 100 },
    ])
    const d = device(vault)
    await d.write('old.md', 'dated before 1970')
    // What a crash left behind on a host that reported a negative mtime: a batch the server
    // will refuse outright, every time it is replayed.
    await d.state.setJournal({
      batchId: 'poison',
      ops: [
        {
          op: 'create',
          path: 'old.md',
          sha: await shaOfText('dated before 1970'),
          size: 'dated before 1970'.length,
          mtime: -1,
        },
      ],
      idempotencyKey: 'poison-key',
      startedAt: '2026-09-05T00:00:00.000Z',
    })

    const report = await d.engine.sync()

    expect(report.push.rejected.map((r) => [r.code, r.op.op])).toEqual([
      ['invalid_request', 'create'],
    ])
    expect(await d.state.getJournal()).toBeNull()
    // The pull went ahead, and the scan sent the file as the disk actually dates it.
    expect(report.pull).toMatchObject({ bootstrapped: true, applied: 1 })
    expect(await d.text('theirs.md')).toBe('from yonder')
    expect(report.push.applied).toBe(1)
    expect(d.commits).toHaveLength(2)
    expect(d.commits[1]).toMatchObject([{ op: 'create', path: 'old.md', mtime: 1000 }])
    expect(d.engine.status).toMatchObject({ state: 'idle', lastError: null, pending: 0 })
    expect((await d.engine.sync()).push.committed).toBeNull()
  })

  it('tells its host about every sync that got through and every one that did not', async () => {
    const vault = await ownVault('hooks')
    const reports: unknown[] = []
    const failures: string[] = []
    const d = device(vault, {
      onSync: (report) => reports.push(report),
      onFail: (_error, kind) => failures.push(kind),
    })
    await d.write('note.md', 'body')

    const report = await d.engine.sync()
    expect(reports).toEqual([report])
    expect(failures).toEqual([])

    d.client.commitRaw = async () => {
      throw new EngineError('io', 'the disk is full')
    }
    await d.write('two.md', 'more', 2000)
    await expect(d.engine.sync()).rejects.toThrow('the disk is full')
    expect(reports).toHaveLength(1)
    expect(failures).toEqual(['other'])
  })
})
