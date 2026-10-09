import * as Fs from 'node:fs'
import * as Fsp from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scan, selectiveDefaults } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { PROJECTION_SIZE_CAP } from '../../src/externalDiscovery.js'
import { writeConfig, stateFolder } from '../../src/config.js'
import { runRun } from '../../src/commands/run.js'
import { acquireLock } from '../../src/lock.js'
import * as Safety from '../../src/externalSafety.js'
vi.mock('node:fs', async (load) => ({ ...(await load<typeof import('node:fs')>()) }))
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof import('node:fs/promises')>()),
}))
let dir: string
const cfg = {
  serverUrl: 'https://synthetic.example.test',
  vaultId: 'vault',
  deviceId: 'device',
  deviceToken: 'absd_synthetic',
  deviceName: 'test',
  selective: selectiveDefaults(),
}
beforeEach(async () => {
  const root = resolve(import.meta.dirname, '../../../../.scratch')
  await Fsp.mkdir(root, { recursive: true })
  dir = await Fsp.mkdtemp(join(root, 'discovery-'))
  writeConfig(dir, cfg)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Fsp.rm(dir, { recursive: true, force: true })
})
function traceReads(onRead = () => {}) {
  const paths = new Map<number, string>(),
    bytes = new Map<string, number>(),
    opens: string[] = []
  const count = (path: string, size: number) => {
    if (!path.startsWith(dir + '/') || path.includes('/.abele-sync/')) return
    bytes.set(path, (bytes.get(path) ?? 0) + size)
    onRead()
  }
  const syncOpen = Fs.openSync,
    syncRead = Fs.readSync,
    open = Fsp.open
  vi.spyOn(Fs, 'openSync').mockImplementation(((path: Fs.PathLike, ...args: unknown[]) => {
    const fd = Reflect.apply(syncOpen, Fs, [path, ...args]) as number
    paths.set(fd, String(path))
    opens.push(String(path))
    return fd
  }) as typeof Fs.openSync)
  vi.spyOn(Fs, 'readSync').mockImplementation(((fd: number, ...args: unknown[]) => {
    const size = Reflect.apply(syncRead, Fs, [fd, ...args]) as number
    count(paths.get(fd) ?? '', size)
    return size
  }) as typeof Fs.readSync)
  vi.spyOn(Fsp, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle),
      path = String(args[0])
    opens.push(path)
    vi.spyOn(handle, 'read').mockImplementation((async (...params: unknown[]) => {
      const result = (await Reflect.apply(read, handle, params)) as { bytesRead: number }
      count(path, result.bytesRead)
      return result
    }) as typeof handle.read)
    return handle
  })
  return { bytes, opens }
}
const context = () => ({
  fetch: vi.fn(async () => {
    throw new Error('offline after recovery')
  }),
  env: {},
  revokeTimeoutMs: 20,
  io: { out: () => {}, err: () => {} },
})
describe('projection inventory read budget', () => {
  it('a marker only beyond the capped prefix is ordinary, with discovery never reading past the cap', async () => {
    const path = 'renamed.bin',
      file = join(dir, path)
    await Fsp.writeFile(
      file,
      '{' + ' '.repeat(PROJECTION_SIZE_CAP + 1024) + '"format":"abele.external", broken'
    )
    const trace = traceReads(),
      lock = await acquireLock(dir)
    try {
      await Safety.inspectProjectionInventory(dir, {
        guard: () => {
          if (!lock.held()) throw new Error('lost')
        },
      })
      expect(trace.bytes.get(file)).toBe(PROJECTION_SIZE_CAP)
      const index = JSON.parse(
        Fs.readFileSync(join(stateFolder(dir), 'projection-index.json'), 'utf8')
      ) as { entries: { path: string; marker: boolean }[] }
      expect(index.entries.find((entry) => entry.path === path)?.marker).toBe(false)
    } finally {
      lock()
    }
    // Ordinary sync may read ordinary content; only projection discovery is prefix-bounded.
    vi.restoreAllMocks()
    const raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
    try {
      const result = await scan(new NodeFileSystem(dir), raw, { excluded: () => false })
      expect(result.ops).toContainEqual(
        expect.objectContaining({ op: 'create', path, size: Fs.statSync(file).size })
      )
    } finally {
      raw.close()
    }
  })
  it('stat-first discovery reads only capped prefixes, skips excluded files and runs one pass per start', async () => {
    await Fsp.mkdir(join(dir, 'Excluded'))
    await Fsp.mkdir(join(dir, 'Ignored'))
    await Fsp.writeFile(join(dir, 'Excluded', 'small.json'), '{"ordinary": true}')
    await Fsp.writeFile(join(dir, 'Ignored', 'small.json'), '{"ordinary": true}')
    await Fsp.writeFile(join(dir, '.abele-sync-ignore'), 'Ignored/\n')
    writeConfig(dir, { ...cfg, selective: { ...cfg.selective, excludedFolders: ['Excluded'] } })
    const large = join(dir, 'export.canvas'),
      small = join(dir, 'ordinary.json')
    await Fsp.writeFile(large, JSON.stringify({ ordinary: 'x'.repeat(200_000) }))
    await Fsp.writeFile(small, '{"ordinary": true}')
    const trace = traceReads(),
      ctx = context()
    await expect(runRun({ dir, once: true }, ctx)).rejects.toMatchObject({ code: 'offline' })
    expect(trace.bytes.get(large)).toBe(PROJECTION_SIZE_CAP)
    expect(trace.bytes.get(join(dir, 'Excluded', 'small.json')) ?? 0).toBe(0)
    expect(trace.bytes.get(join(dir, 'Ignored', 'small.json')) ?? 0).toBe(0)
    expect(trace.bytes.get(small)).toBe(Fs.statSync(small).size)
  })
  it('the durable index skips unchanged path/size/mtime, invalidates edits, and follows renamed small markers', async () => {
    const file = join(dir, 'ordinary.json')
    await Fsp.writeFile(file, '{"ordinary":true}')
    const first = traceReads()
    await expect(runRun({ dir, once: true }, context())).rejects.toMatchObject({ code: 'offline' })
    expect(first.bytes.get(file)).toBe(Fs.statSync(file).size)
    vi.restoreAllMocks()
    const second = traceReads()
    await expect(runRun({ dir, once: true }, context())).rejects.toMatchObject({ code: 'offline' })
    expect(second.bytes.get(file) ?? 0).toBe(0)
    expect(Fs.existsSync(join(stateFolder(dir), 'projection-index.json'))).toBe(true)
    await Fsp.writeFile(file, '{"format":"abele.external","schema":1}')
    await Fsp.rename(file, join(dir, 'renamed.bin'))
    await expect(runRun({ dir, once: true }, context())).rejects.toMatchObject({
      reason: 'recovery-required',
    })
    expect(second.bytes.get(join(dir, 'renamed.bin'))).toBeGreaterThan(0)
  })
  it('discovery yields during a long pass so the owning lock heartbeat remains alive', async () => {
    const files = 80,
      readMs = 3,
      timing = { heartbeatMs: 10, watchMs: 100 }
    for (let n = 0; n < files; n++) await Fsp.writeFile(join(dir, `${n}.json`), '{"ordinary":true}')

    // Model CPU work per read, not host scheduling delays. The whole pass costs
    // 240 ms, longer than the lock's 80 ms give-up; a synchronous pass must lose it.
    // Only actual event-loop turns may deliver the pending heartbeat intervals.
    let elapsed = 0,
      delivered = 0,
      reads = 0
    const wall = Date.now()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    vi.spyOn(Date, 'now').mockImplementation(() => wall + elapsed)
    traceReads(() => {
      reads++
      elapsed += readMs
    })
    const turns: { reads: number; beat: number }[] = [],
      immediate = globalThis.setImmediate,
      lockFile = join(stateFolder(dir), 'lock'),
      beatOf = () =>
        (JSON.parse(Fs.readFileSync(lockFile, 'utf8').split('\n')[1]!) as { beat: number }).beat
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(((
      callback: (...args: unknown[]) => void,
      ...args: unknown[]
    ) =>
      immediate(() => {
        vi.advanceTimersByTime(elapsed - delivered)
        delivered = elapsed
        turns.push({ reads, beat: beatOf() })
        callback(...args)
      })) as typeof setImmediate)
    const lock = await acquireLock(dir, timing)
    try {
      await Safety.inspectProjectionInventory(dir, {
        guard: () => {
          expect(lock.held()).toBe(true)
        },
      })
      expect(reads).toBe(files)
      expect(turns.length).toBeGreaterThanOrEqual(5)
      // Beats must land DURING discovery, not just after all the reads finish.
      expect(turns[0]!.reads).toBeGreaterThan(0)
      expect(turns[0]!.reads).toBeLessThan(files)
      let previousReads = 0,
        previousBeat = 0
      for (const turn of turns) {
        expect(turn.reads - previousReads).toBeLessThanOrEqual(16)
        expect(turn.beat).toBeGreaterThan(previousBeat)
        previousReads = turn.reads
        previousBeat = turn.beat
      }
      expect(reads - previousReads).toBeLessThanOrEqual(16)
      expect(lock.held()).toBe(true)
    } finally {
      lock()
    }
  })
  it('a raced candidate read is capped even if the file grows after stat', async () => {
    const file = join(dir, 'raced.json')
    await Fsp.writeFile(file, '{}')
    const open = Fsp.open
    let bytesRead = 0
    vi.spyOn(Fsp, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === file) await Fsp.writeFile(file, '{' + ' '.repeat(100_000) + '}')
      const handle = await open(...args),
        read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation((async (...params: unknown[]) => {
        const result = (await Reflect.apply(read, handle, params)) as { bytesRead: number }
        if (String(args[0]) === file) bytesRead += result.bytesRead
        return result
      }) as typeof handle.read)
      return handle
    })
    const lock = await acquireLock(dir)
    try {
      await Safety.inspectProjectionInventory(dir, {
        guard: () => {
          if (!lock.held()) throw new Error('lost')
        },
      })
      expect(bytesRead).toBeLessThanOrEqual(16 * 1024)
    } finally {
      lock()
    }
  })
})
