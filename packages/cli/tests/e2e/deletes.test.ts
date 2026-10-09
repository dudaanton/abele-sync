import { existsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { acquireLock } from '../../src/lock.js'
import type { CliIo } from '../../src/context.js'
import {
  cleanupFolders,
  withFolderWork,
  waitForFolderWork,
  cli,
  folder,
  clientFor,
  EMAIL,
  PASSWORD,
  read,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * The mass-delete guard from the command line: `run` holds a large
 * batch of deletes and says so, `status` shows it, `deletes` lists it and files a decision,
 * and `restore --deleted-since` brings back what was sent to the trash after all.
 */

let server: SpawnedServer

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
}, SETUP_MS)

afterAll(async () => {
  await waitForFolderWork()
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

const name = (k: number): string => `n${String(k).padStart(3, '0')}.md`
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A vault of 100 notes on both folders; then 60 of them removed from `a`. */
async function sixtyGone(label: string): Promise<{ a: string; b: string }> {
  const { a, b } = await vaultPair(server, label)
  for (let k = 0; k < 100; k++) await write(b, name(k), `note ${k}\n`)
  await syncOnce(b)
  await syncOnce(a)
  for (let k = 0; k < 60; k++) await rm(join(a, name(k)))
  return { a, b }
}

/** The fingerprint `deletes` lists the held set under, for `--confirm --expect`. */
async function fingerprint(dir: string): Promise<string> {
  const listed = await cli(['deletes', '--dir', dir])
  const found = /--expect (\S+)/.exec(listed.all)
  if (found === null) throw new Error(`no fingerprint in: ${listed.all}`)
  return found[1]!
}

async function trashCount(dir: string): Promise<number> {
  return (await clientFor(dir).trash()).length
}

describe('a run that would delete 60 of 100 files', () => {
  // Each case transfers 100 real files before checking the guard. Await command completion
  // with a generous safety deadline rather than the project's 20-second wall-clock budget.
  it(
    'holds them, says so, and status shows it',
    () =>
      withFolderWork(async () => {
        const { a } = await sixtyGone('Held')
        const run = await cli(['run', '--dir', a, '--once'])
        expect(run.code).toBe(0)
        // The hint names the set it was printed for, so the command in it is one that works.
        const line = `held deletes 60 — abele-sync deletes --dir ${a} --confirm --expect ${await fingerprint(a)} | --restore`
        expect(run.out).toContain(line)
        expect(await trashCount(a)).toBe(0)
        // The summary's own count is of changes the pull held back, and is not called held deletes.
        const summary = run.out.find((one) => one.startsWith('sync: done'))
        expect(summary).toMatch(/pulls waiting 0\)$/)
        expect(summary).not.toMatch(/held/)

        const status = await cli(['status', '--dir', a])
        expect(status.code).toBe(0)
        expect(status.out).toContain(line)
        // The held deletes are not what is waiting to go.
        expect(status.out).toContain(`${'pending'.padEnd(10)} 0`)

        const listed = await cli(['deletes', '--dir', a])
        expect(listed.code).toBe(0)
        expect(listed.out[0]).toBe('60 deletions held')
        expect(listed.out).toContain(`  ${name(0)}`)
      }),
    SETUP_MS
  )

  it(
    'sends them once confirmed',
    () =>
      withFolderWork(async () => {
        const { a } = await sixtyGone('Confirmed')
        await syncOnce(a)
        const decided = await cli([
          'deletes',
          '--dir',
          a,
          '--confirm',
          '--expect',
          await fingerprint(a),
        ])
        expect(decided.code).toBe(0)
        expect(decided.all).toMatch(/60 deletions will be sent at the next sync/)
        await syncOnce(a)
        expect(await trashCount(a)).toBe(60)
        expect((await cli(['deletes', '--dir', a])).out).toEqual(['no deletions held'])
      }),
    SETUP_MS
  )

  it(
    'puts them back on the disk once restored',
    () =>
      withFolderWork(async () => {
        const { a } = await sixtyGone('Put back')
        await syncOnce(a)
        const decided = await cli(['deletes', '--dir', a, '--restore'])
        expect(decided.code).toBe(0)
        expect(decided.all).toMatch(/60 files will come back at the next sync/)
        await syncOnce(a)
        for (let k = 0; k < 60; k++) expect(existsSync(join(a, name(k)))).toBe(true)
        expect(await read(a, name(7))).toBe('note 7\n')
        expect(await trashCount(a)).toBe(0)
      }),
    SETUP_MS
  )

  it(
    'confirms only the set that was listed, and never beside a daemon on another machine',
    () =>
      withFolderWork(async () => {
        const { a } = await sixtyGone('Listed')
        await syncOnce(a)
        const listed = await fingerprint(a)
        expect(listed).toMatch(/^60-[0-9a-f]{8}$/)

        const blind = await cli(['deletes', '--dir', a, '--confirm'])
        expect(blind.code).toBe(2)
        expect(blind.all).toMatch(/--expect/)

        // Twenty more go before anyone confirms: the list the person read is not the set held now.
        for (let k = 60; k < 80; k++) await rm(join(a, name(k)))
        await syncOnce(a)
        const stale = await cli(['deletes', '--dir', a, '--confirm', '--expect', listed])
        expect(stale.code).toBe(2)
        expect(stale.all).toMatch(/changed since/)
        await syncOnce(a)
        expect(await trashCount(a)).toBe(0)
        expect((await cli(['deletes', '--dir', a])).out[0]).toBe('80 deletions held')

        // A daemon on another machine holds the vault: its database is not written from here.
        const lock = join(a, '.abele-sync', 'lock')
        let beat = 0
        const theirs = (): void =>
          writeFileSync(
            lock,
            `4242\n${JSON.stringify({ instance: 'theirs', host: 'nas', boot: 'b', beat: beat++ })}\n`
          )
        theirs()
        const timer = setInterval(theirs, 5)
        try {
          const lines: string[] = []
          const io: CliIo = {
            out: (line) => lines.push(line),
            err: (line) => lines.push(line),
            lockTiming: { heartbeatMs: 10, watchMs: 120 },
          }
          const code = await runCli(['deletes', '--dir', a, '--restore'], {}, io)
          expect(code).toBe(3)
          expect(lines.join('\n')).toMatch(/on nas/)
        } finally {
          clearInterval(timer)
        }
        await rm(lock)
        await syncOnce(a)
        expect(existsSync(join(a, name(0)))).toBe(false)
        expect((await cli(['deletes', '--dir', a])).out[0]).toBe('80 deletions held')

        // A `run --once`, a `restore` or a `join` holds the lock here: no daemon, and no interval.
        const expected = await fingerprint(a)
        const release = await acquireLock(a)
        try {
          const decided = await cli(['deletes', '--dir', a, '--confirm', '--expect', expected])
          expect(decided.code).toBe(0)
          expect(decided.all).toMatch(/the next sync takes it/)
          expect(decided.all).not.toMatch(/daemon applies it|--interval/)
        } finally {
          release()
        }
      }),
    SETUP_MS
  )

  it(
    'refuses both decisions at once',
    () =>
      withFolderWork(async () => {
        const run = await cli(['deletes', '--dir', await folder(), '--confirm', '--restore'])
        expect(run.code).toBe(2)
      }),
    SETUP_MS
  )

  it(
    'pokes a running daemon, which sends them at once',
    () =>
      withFolderWork(async () => {
        const deadline = Date.now() + SETUP_MS - 10_000
        const { a } = await sixtyGone('Poked')
        const lines: string[] = []
        const io: CliIo = { out: (line) => lines.push(line), err: (line) => lines.push(line) }
        // A long interval: only the poke can make it sync again in time.
        const daemon = runCli(['run', '--dir', a, '--interval', '3600'], {}, io)
        try {
          const said = (): string | undefined => lines.find((one) => one.startsWith('held deletes'))
          while (said() === undefined && Date.now() < deadline) await sleep(20)
          const held = said()
          expect(held).toBe(
            `held deletes 60 — abele-sync deletes --dir ${a} --confirm --expect ${await fingerprint(a)} | --restore`
          )

          // The command the daemon printed, taken as it stands, is the one that confirms.
          const command = /abele-sync (deletes .*--expect \S+)/.exec(held!)![1]!.split(' ')
          const decided = await cli(command)
          expect(decided.code).toBe(0)
          expect(decided.all).toMatch(/the running daemon was asked to sync now/)
          while ((await trashCount(a)) < 60 && Date.now() < deadline) await sleep(50)
          expect(await trashCount(a)).toBe(60)
        } finally {
          process.kill(process.pid, 'SIGTERM')
          expect(await daemon).toBe(0)
        }
        expect(process.listenerCount('SIGUSR1')).toBe(0)
      }),
    SETUP_MS
  )
})
