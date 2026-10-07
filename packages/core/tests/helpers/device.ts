import { expect } from 'vitest'
import {
  encodeText,
  MemoryFileSystem,
  MemoryStateStore,
  selectiveDefaults,
  sha256,
  SyncEngine,
  type IgnoreRules,
  type RejectedOp,
  type SelectiveSettings,
  type SyncReport,
  type VaultClient,
} from '../../src/index.js'
import type { Harness } from './harness.js'

/**
 * A device as the scenario tier drives one: the production engine over a memory disk and a
 * memory state, with every request it makes to the server counted. Everything here goes
 * through `SyncEngine`, and the only thing a test touches
 * directly is the disk — exactly what a person would.
 */

export interface DeviceStats {
  blobPuts: number
  blobHeads: number
  blobGets: number
  commits: number
}

export interface DeviceOptions {
  /** What this device syncs; everything, unless said otherwise. Mutable, so a test can toggle it. */
  selective?: SelectiveSettings
  ignore?: IgnoreRules
  now?: () => number
  /** A disk and a state to take over: the same device in a fresh process. */
  fs?: MemoryFileSystem
  state?: MemoryStateStore
  /** The side this device takes on files both it and the vault have, while it joins. */
  joinPrefer?: 'mine' | 'theirs'
  /** The transport under the client, for a test that watches every request go by. */
  fetch?: typeof fetch
  /** Whether this device still holds the vault, as a daemon's lock says; see `EngineOptions`. */
  stillHeld?: () => boolean
  /** Which wire paths the pulls stage rather than write, as the plugin's Obsidian settings. */
  defer?: (wirePath: string) => boolean
}

/** One clock for every device, so "newer" between two devices is never a tie. */
let clock = 1_700_000_000_000
export const nextMtime = (): number => ++clock

const decoder = new TextDecoder()

export class Device {
  readonly fs: MemoryFileSystem
  readonly state: MemoryStateStore
  readonly engine: SyncEngine
  /** The engine's client, its counted methods already in place. */
  readonly client: VaultClient
  readonly selective: SelectiveSettings
  readonly stats: DeviceStats = { blobPuts: 0, blobHeads: 0, blobGets: 0, commits: 0 }
  /** Every op the server refused, across every sync. */
  readonly rejected: RejectedOp[] = []
  /** Every line the engine logged. */
  readonly lines: string[] = []

  constructor(
    harness: Harness,
    vaultId: string,
    readonly deviceToken: string,
    readonly name: string,
    opts: DeviceOptions = {}
  ) {
    const extra = opts.fetch === undefined ? {} : { fetch: opts.fetch }
    this.client = counted(harness.clientFor(deviceToken, vaultId, extra), this.stats)
    this.fs = opts.fs ?? new MemoryFileSystem()
    this.state = opts.state ?? new MemoryStateStore()
    this.selective = opts.selective ?? selectiveDefaults()
    this.engine = new SyncEngine({
      client: this.client,
      fs: this.fs,
      state: this.state,
      selective: this.selective,
      ...(opts.ignore === undefined ? {} : { ignore: opts.ignore }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.joinPrefer === undefined ? {} : { joinPrefer: opts.joinPrefer }),
      ...(opts.stillHeld === undefined ? {} : { stillHeld: opts.stillHeld }),
      ...(opts.defer === undefined ? {} : { defer: opts.defer }),
      log: (line) => this.lines.push(line),
    })
  }

  /* ── Local edits ─────────────────────────────────────────────────────── */

  write(path: string, content: string | Uint8Array, mtime = nextMtime()): Promise<void> {
    const bytes = typeof content === 'string' ? encodeText(content) : content
    return this.fs.writeAtomic(path, bytes, mtime)
  }

  rm(path: string): Promise<void> {
    return this.fs.remove(path)
  }

  mv(from: string, to: string): Promise<void> {
    return this.fs.move(from, to)
  }

  /* ── The disk, for assertions ────────────────────────────────────────── */

  async text(path: string): Promise<string | undefined> {
    const bytes = await this.bytes(path)
    return bytes === undefined ? undefined : decoder.decode(bytes)
  }

  async bytes(path: string): Promise<Uint8Array | undefined> {
    return (await this.fs.stat(path)) === null ? undefined : this.fs.read(path)
  }

  /** Whether the file at `path` is exactly these bytes. */
  async holds(path: string, bytes: Uint8Array): Promise<boolean> {
    const have = await this.bytes(path)
    return have !== undefined && Buffer.from(have).equals(bytes)
  }

  has(path: string): boolean {
    return this.fs.snapshot().has(path)
  }

  /** Every path on the disk, in code-unit order. */
  paths(): string[] {
    return [...this.fs.snapshot().keys()].sort()
  }

  /** The feed position the state holds. */
  cursor(): Promise<number> {
    return this.state.getCursor()
  }

  /* ── Sync ────────────────────────────────────────────────────────────── */

  async sync(): Promise<SyncReport> {
    return this.report(await this.engine.sync())
  }

  /** The manifest walked again, for a device that now syncs more than it did. */
  async rescan(): Promise<SyncReport> {
    return this.report(await this.engine.rescan())
  }

  private report(report: SyncReport): SyncReport {
    this.rejected.push(...report.push.rejected)
    return report
  }

  /** Every entry's file is on the disk and holds the entry's bytes. */
  async assertStateMatchesDisk(): Promise<void> {
    for await (const entry of this.state.all()) {
      const bytes = await this.bytes(entry.path)
      expect(bytes, `${this.name}: ${entry.path} is in the state but not on the disk`).toBeDefined()
      expect(await sha256(bytes ?? new Uint8Array()), `${this.name}: ${entry.path}`).toBe(entry.sha)
    }
  }
}

/** The client with its four traffic-bearing methods counted, before the engine sees it. */
function counted(client: VaultClient, stats: DeviceStats): VaultClient {
  const putBlob = client.putBlob.bind(client)
  client.putBlob = async (sha, bytes) => {
    stats.blobPuts++
    await putBlob(sha, bytes)
  }
  const hasBlob = client.hasBlob.bind(client)
  client.hasBlob = async (sha) => {
    stats.blobHeads++
    return hasBlob(sha)
  }
  const getBlob = client.getBlob.bind(client)
  client.getBlob = async (sha) => {
    stats.blobGets++
    return getBlob(sha)
  }
  const commitRaw = client.commitRaw.bind(client)
  client.commitRaw = async (ops, key) => {
    stats.commits++
    return commitRaw(ops, key)
  }
  return client
}

/** Every path with its bytes, in path order, as latin1 so the diff of a mismatch reads. */
const listing = (device: Device): Record<string, string> =>
  Object.fromEntries(
    [...device.fs.snapshot()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, bytes]) => [path, Buffer.from(bytes).toString('latin1')])
  )

/**
 * Sync each device twice in order, then assert every disk is byte-equal to the first, and
 * that every device's state describes its disk.
 */
export async function converge(...devices: Device[]): Promise<void> {
  for (let round = 0; round < 2; round++) for (const device of devices) await device.sync()
  const [first, ...rest] = devices
  if (first === undefined) return
  for (const device of rest) {
    expect(listing(device), `${device.name} differs from ${first.name}`).toEqual(listing(first))
  }
  for (const device of devices) await device.assertStateMatchesDisk()
}
