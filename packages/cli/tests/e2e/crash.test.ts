import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { stateFolder } from '../../src/config.js'
import type { CliIo } from '../../src/context.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { buildEngine, fileIdFor, openVault, stateDbFile } from '../../src/vault.js'
import {
  cleanupFolders,
  cli,
  clientFor,
  ctxFor,
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
 * The daemon dying at the worst moment, and the daemon refusing to run twice over one folder.
 *
 * The moment is between the commit reaching the server and its answer reaching the daemon: the
 * server has filed a version, the daemon's journal still says the batch is in flight. Killing a
 * child process there cannot be timed, so the engine is run in-process — the very adapters
 * `run` wires up — on a client whose `commitRaw` carries the request through and then throws,
 * which is what the daemon sees when the socket drops on the way back.
 */

let server: SpawnedServer
let a: string
let b: string

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  const pair = await vaultPair(server, 'Crash')
  a = pair.a
  b = pair.b
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

/** The folder's journal, read and closed; null once a push has been recorded. */
async function journalOf(dir: string): Promise<unknown> {
  const state = SqliteStateStore.open(stateDbFile(dir))
  try {
    return await state.getJournal()
  } finally {
    state.close()
  }
}

describe('a daemon killed between the upload and the commit answer', () => {
  it('replays the batch on the next run: one version, the file synced, the journal cleared', async () => {
    await write(a, 'note.md', 'typed once\n')

    const vault = openVault(a, ctxFor())
    try {
      const through = vault.client.commitRaw.bind(vault.client)
      vault.client.commitRaw = async (ops, key) => {
        await through(ops, key)
        throw new Error('killed before the answer arrived')
      }
      const engine = buildEngine(vault, { fallbackMs: 300_000, log: () => undefined })
      await expect(engine.sync()).rejects.toThrow('killed before the answer arrived')
      await engine.stop()
    } finally {
      vault.close()
    }
    // What the crash left: a journal naming the batch, and a server that already has it.
    expect(await journalOf(a)).not.toBeNull()

    expect(await syncOnce(a)).toContain('sync: done')
    expect(await journalOf(a)).toBeNull()

    const client = clientFor(a)
    const state = SqliteStateStore.open(stateDbFile(a))
    try {
      const fileId = await fileIdFor(client, state, 'note.md')
      expect((await client.versions(fileId)).map((v) => v.no)).toEqual([1])
    } finally {
      state.close()
    }

    await syncOnce(b)
    expect(await read(b, 'note.md')).toBe('typed once\n')
  })
})

describe('the lock', () => {
  it('makes a second run on the same folder exit 3 while the daemon holds it', async () => {
    const out: string[] = []
    const io: CliIo = { out: (line) => out.push(line), err: (line) => out.push(line) }
    const daemon = runCli(['run', '--dir', a], {}, io)
    const deadline = Date.now() + 10_000
    while (!out.some((line) => line.startsWith('state:')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    try {
      expect(out[0]).toContain(`watching ${a}`)
      expect(existsSync(join(stateFolder(a), 'lock'))).toBe(true)

      const second = await cli(['run', '--dir', a, '--once'])
      expect(second.code).toBe(3)
      expect(second.err.join('\n')).toContain(`another abele-sync is running for ${a}`)
      expect(second.err.join('\n')).toContain(String(process.pid))
    } finally {
      process.kill(process.pid, 'SIGTERM')
      expect(await daemon).toBe(0)
    }
    expect(existsSync(join(stateFolder(a), 'lock'))).toBe(false)
  })
})
