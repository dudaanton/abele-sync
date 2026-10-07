import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import type { CliIo } from '../../src/context.js'
import { acquireLock } from '../../src/lock.js'
import { writeLive } from '../../src/progress.js'
import {
  cleanupFolders,
  cli,
  EMAIL,
  manifestPaths,
  PASSWORD,
  SETUP_MS,
  vaultPair,
  write,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * What is left of a push, counted down while it runs (B14): the daemon files the engine's
 * falling count where `status` reads it from another process, and says it now and then.
 */

let server: SpawnedServer

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const pendingLine = (out: string[]): string | undefined =>
  out.find((line) => line.startsWith('pending'))

describe('a daemon pushing many files', () => {
  it('counts what is left down as the files go, and leaves no count behind', async () => {
    const { a } = await vaultPair(server, 'Counted')
    const N = 150
    for (let k = 0; k < N; k++) await write(a, `c${k}.md`, `note ${k}\n`)
    const live = join(a, '.abele-sync', 'live')
    const seen = new Set<number>()
    const lines: string[] = []
    const io: CliIo = {
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
      progressTiming: { fileMs: 0, lineMs: 0 },
    }
    let watching = true
    const watcher = (async () => {
      while (watching) {
        try {
          seen.add((JSON.parse(readFileSync(live, 'utf8')) as { pending: number }).pending)
        } catch {
          /* not there, or caught between write and rename */
        }
        await sleep(1)
      }
    })()
    const daemon = runCli(['run', '--dir', a, '--interval', '3600'], {}, io)
    try {
      const deadline = Date.now() + 30_000
      while ((await manifestPaths(a)).length < N && Date.now() < deadline) await sleep(50)
      const until = Date.now() + 10_000
      while (existsSync(live) && Date.now() < until) await sleep(20)
    } finally {
      watching = false
      await watcher
      process.kill(process.pid, 'SIGTERM')
      expect(await daemon).toBe(0)
    }
    const between = [...seen].filter((n) => n > 0 && n < N)
    expect(between.length).toBeGreaterThan(1)
    expect(lines.some((line) => /^push: \d+ of 150 left$/.test(line))).toBe(true)
    expect(existsSync(live)).toBe(false)
  })
})

describe('status beside a daemon', () => {
  it("shows the daemon's count while its push runs, and the scan's otherwise", async () => {
    const { a } = await vaultPair(server, 'Beside')
    for (let k = 0; k < 5; k++) await write(a, `s${k}.md`, `note ${k}\n`)
    const release = await acquireLock(a, { daemon: true })
    try {
      writeLive(a, 3)
      const during = await cli(['status', '--dir', a])
      expect(during.code).toBe(0)
      expect(pendingLine(during.out)).toBe(`${'pending'.padEnd(10)} 3 (the daemon is pushing)`)
    } finally {
      release()
    }
    // The lock gone, the count is nobody's: the scan says what is waiting.
    const after = await cli(['status', '--dir', a])
    expect(pendingLine(after.out)).toBe(`${'pending'.padEnd(10)} 5`)
  })
})
