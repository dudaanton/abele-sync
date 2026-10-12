import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect } from 'vitest'
import { V2EngineClient } from '@abele/sync-core'
import { runCli } from '../../../src/cli.js'
import { readConfig, writeConfig, type DaemonConfig } from '../../../src/config.js'
import { REVOKE_TIMEOUT_MS, type CliIo, type CommandContext } from '../../../src/context.js'
import type { SpawnedServer } from './spawnServer.js'

/**
 * Two folders on one vault, driven the way a person would drive them: files written to disk,
 * `abele-sync run --once` in each folder in turn, and the disk read back.
 *
 * Everything here is either the program itself (`runCli`, in-process, with its own `io`) or the
 * plain filesystem. The one place a test reaches past the daemon is `clientFor`, a client on the
 * folder's own device token, for what a folder cannot show — the server's manifest, a file's
 * versions, the vault's conflict setting.
 */

/** The device names, which is what a conflict copy is named after. */
export const DEVICE_A = 'laptop'
export const DEVICE_B = 'phone'
/** Every suite spawns a server, and a cold build of it takes longer than a test may. */
export const SETUP_MS = 5 * 60_000

export interface Run {
  code: number
  out: string[]
  err: string[]
  all: string
}

export interface Pair {
  a: string
  b: string
  vaultId: string
}

/** The program, on buffers. Nothing it prints reaches the test output. */
export async function cli(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) }
  const code = await runCli(argv, env, io)
  return { code, out, err, all: [...out, ...err].join('\n') }
}

/** What a command opened in-process is handed: the real transport, and lines kept nowhere. */
export const ctxFor = (): CommandContext => ({
  io: { out: () => undefined, err: () => undefined },
  env: {},
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  revokeTimeoutMs: REVOKE_TIMEOUT_MS,
})

let temps: string[] = []
const folderWork = new Set<Promise<void>>()

/** Vitest timeouts do not cancel async test bodies. Drain them before tearing down fixtures. */
export function withFolderWork(work: () => Promise<void>): Promise<void> {
  const task = work()
  const settled = task.then(
    () => {
      folderWork.delete(settled)
    },
    () => {
      folderWork.delete(settled)
    }
  )
  folderWork.add(settled)
  return task
}

/** Includes child-process exit waits in the test body's finally blocks. */
export async function waitForFolderWork(): Promise<void> {
  while (folderWork.size > 0) await Promise.all([...folderWork])
}

/** A fresh, empty vault folder, removed by `cleanupFolders`. */
export async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'abele-vault-'))
  temps.push(dir)
  return dir
}

/** Every folder made so far, gone. For an `afterAll`; safe when a test failed half way. */
export async function cleanupFolders(): Promise<void> {
  await waitForFolderWork()
  const dirs = temps
  temps = []
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
}

/**
 * Two connected folders in one synthetic space, with independent laptop/phone tokens.
 * Named spaces are provisioned by the operator fixture, not selected by the CLI.
 */
export async function vaultPair(server: SpawnedServer, vaultName: string): Promise<Pair> {
  const a = await folder()
  const b = await folder()
  await init(server, a, vaultName, DEVICE_A)
  await init(server, b, vaultName, DEVICE_B)
  return { a, b, vaultId: config(a).vaultId }
}

async function init(
  server: SpawnedServer,
  dir: string,
  vaultName: string,
  deviceName: string
): Promise<void> {
  const run = await cli([
    'connect',
    '--dir',
    dir,
    '--token',
    server.tokenFor(vaultName, deviceName),
  ])
  if (run.code !== 0) throw new Error(`connect of ${dir} exited ${run.code}: ${run.all}`)
}

/** One `run --once` in the folder, or an error carrying what it printed. */
export async function syncOnce(dir: string): Promise<string> {
  const run = await cli(['run', '--dir', dir, '--once'])
  if (run.code !== 0 || run.err.length > 0) {
    throw new Error(`run --once in ${dir} exited ${run.code}: ${run.all}`)
  }
  return run.out.join('\n')
}

export const read = (dir: string, path: string): Promise<string> =>
  readFile(join(dir, path), 'utf8')

export const bytes = (dir: string, path: string): Promise<Buffer> => readFile(join(dir, path))

/** Writes a file, making the folders above it. */
export async function write(
  dir: string,
  path: string,
  content: string | Uint8Array
): Promise<void> {
  const file = join(dir, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

/** Sets a file's modification time, in milliseconds since the epoch. */
export const touch = (dir: string, path: string, mtimeMs: number): Promise<void> =>
  utimes(join(dir, path), mtimeMs / 1000, mtimeMs / 1000)

/** The engine's own two paths, which a listing of what the vault holds leaves out. */
const ENGINE_OWN = new Set(['.abele-sync', '.abele-sync-ignore'])

/** Every file under the folder, as wire paths, sorted; the daemon's own state left out. */
export async function listing(dir: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (prefix: string): Promise<void> => {
    for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (prefix === '' && ENGINE_OWN.has(entry.name)) continue
      if (entry.isDirectory()) await walk(path)
      else found.push(path)
    }
  }
  await walk('')
  return found.sort()
}

/**
 * Syncs each folder twice, in turn, and then insists they hold the same files with the same
 * bytes. Two rounds each: the first carries each side's changes up and the other side's down,
 * the second brings back what the server made of the two together.
 */
export async function converge(a: string, b: string): Promise<void> {
  for (const dir of [a, b, a, b]) await syncOnce(dir)
  const left = await listing(a)
  expect(await listing(b)).toEqual(left)
  for (const path of left) expect(await bytes(b, path)).toEqual(await bytes(a, path))
}

/** The folder's config, which `connect` must have written. */
export function config(dir: string): DaemonConfig {
  const cfg = readConfig(dir)
  if (cfg === null) throw new Error(`${dir} has no config`)
  return cfg
}

/** Rewrites the folder's selective settings, the way a person editing `config.json` would. */
export function setSelective(dir: string, patch: Partial<DaemonConfig['selective']>): void {
  const cfg = config(dir)
  writeConfig(dir, { ...cfg, selective: { ...cfg.selective, ...patch } })
}

/** A client on the folder's own device token, for what the folder cannot show. */
export function clientFor(dir: string): V2EngineClient {
  return new V2EngineClient(config(dir).deviceToken, {
    fetch: globalThis.fetch,
    userAgent: 'abele-sync-e2e',
  })
}

/** The live paths the server holds for the folder's vault, sorted. */
export async function manifestPaths(dir: string): Promise<string[]> {
  const client = clientFor(dir)
  const paths: string[] = []
  let cursor: string | null = null
  do {
    const page = await client.manifest(cursor)
    paths.push(...page.items.map((item) => item.path))
    cursor = page.next
  } while (cursor !== null)
  return paths.sort()
}
