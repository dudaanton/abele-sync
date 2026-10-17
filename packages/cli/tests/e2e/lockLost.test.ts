import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { stateFolder } from '../../src/config.js'
import type { CliIo } from '../../src/context.js'
import { SqliteStateStore } from '@abele/sync-node'
import { stateDbFile } from '../../src/vault.js'
import {
  cleanupFolders,
  manifestPaths,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * A daemon whose lock is taken over while a sync is under way: it exits
 * 3, and nothing it would have done after the loss reaches the disk or the server. The takeover
 * is timed from inside the daemon's own transport, so it lands in the middle of the run.
 */

let server: SpawnedServer

beforeAll(async () => {
  server = await spawnServer()
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

// Detect takeover quickly, but leave startup enough stall tolerance on a busy runner.
// Expiration itself is exercised by the clock/stall unit tests, not these takeover tests.
const TIMING = { heartbeatMs: 20, watchMs: 10_000 }
const THEIRS = `4242\n${JSON.stringify({ instance: 'theirs', host: 'another-machine', boot: 'b', beat: 0 })}\n`
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The daemon in `dir`, whose transport hands the lock to another process the first time a
 * request matches, and lets that request through only once the daemon has had time to notice.
 */
async function daemonLosing(
  dir: string,
  when: (method: string, url: string) => boolean,
  flags: string[] = [],
  startupStallMs = 0
): Promise<{ code: number; lines: string[]; tookOver: boolean }> {
  const lines: string[] = []
  let tookOver = false
  let firstRequest = true
  const io: CliIo = {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    lockTiming: TIMING,
    fetch: async (input, init) => {
      if (firstRequest) {
        firstRequest = false
        // A busy runner can block startup before the first heartbeat. This test exercises
        // takeover, so that delay must not expire the lock before the download is reached.
        const until = performance.now() + startupStallMs
        while (performance.now() < until) {
          /* synchronous startup work */
        }
      }
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (!tookOver && when(method, url)) {
        tookOver = true
        writeFileSync(join(stateFolder(dir), 'lock'), THEIRS)
        await sleep(TIMING.heartbeatMs * 5)
      }
      return globalThis.fetch(input, init)
    },
  }
  const code = await runCli(['run', '--dir', dir, ...flags], {}, io)
  return { code, lines, tookOver }
}

async function entryOf(dir: string, path: string): Promise<unknown> {
  const state = SqliteStateStore.open(stateDbFile(dir))
  try {
    return await state.get(path)
  } finally {
    state.close()
  }
}

describe('a daemon whose lock is taken over mid-sync', () => {
  it('exits 3 and writes nothing it was pulling', async () => {
    const { a, b } = await vaultPair(server, 'Lost pull')
    await write(b, 'note.md', 'from the phone\n')
    await syncOnce(b)

    const run = await daemonLosing(
      a,
      (method, url) => method === 'GET' && url.includes('/v2/files/') && url.includes('/content'),
      [],
      500
    )
    expect(run.tookOver).toBe(true)
    expect(run.code).toBe(3)
    expect(run.lines.join('\n')).toMatch(/lock is no longer this daemon's/)
    expect(existsSync(join(a, 'note.md'))).toBe(false)
    expect(await entryOf(a, 'note.md')).toBeNull()
    // The lock is the other process's, and it is left to it.
    expect(readFileSync(join(stateFolder(a), 'lock'), 'utf8')).toBe(THEIRS)
  })

  it('exits 3 and commits nothing it was uploading', async () => {
    const { a } = await vaultPair(server, 'Lost push')
    await write(a, 'mine.md', 'typed here\n')

    const run = await daemonLosing(
      a,
      (method, url) => method === 'PUT' && url.includes('/v2/uploads/')
    )
    expect(run.tookOver).toBe(true)
    expect(run.code).toBe(3)
    expect(await manifestPaths(a)).not.toContain('mine.md')
    expect(readFileSync(join(stateFolder(a), 'lock'), 'utf8')).toBe(THEIRS)
  })

  it('exits 3 from a single run too, saying the lock went', async () => {
    const { a, b } = await vaultPair(server, 'Lost once')
    await write(b, 'note.md', 'from the phone\n')
    await syncOnce(b)

    const run = await daemonLosing(
      a,
      (method, url) => method === 'GET' && url.includes('/v2/files/') && url.includes('/content'),
      ['--once']
    )
    expect(run.tookOver).toBe(true)
    expect(run.code).toBe(3)
    expect(run.lines.join('\n')).toMatch(/lock is no longer this process's/)
    expect(existsSync(join(a, 'note.md'))).toBe(false)
  })
})
