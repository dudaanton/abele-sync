import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli.js'
import { readConfig } from '../../src/config.js'
import type { CliIo } from '../../src/context.js'
import { cleanupFolders, cli, config, EMAIL, PASSWORD, read, SETUP_MS } from './helpers/folders.js'
import { devicesOn, env, filledPair, initArgs } from './helpers/join.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * `init` on a folder that already holds files, into a vault that already holds files (phase
 * 3b, decision 7): the daemon asks which side wins where both have a file at a terminal, and
 * refuses in a script unless `--prefer` says, before anything is enrolled.
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

describe('init into a vault that already holds files: the question', () => {
  it('refuses without --prefer and without a terminal, and enrols nothing', async () => {
    const { joiner } = await filledPair(server, 'NoTerminal')
    const before = await devicesOn(server, 'NoTerminal')
    const run = await cli(initArgs(server, joiner, 'NoTerminal', 'joiner'), env)
    expect(run.code).toBe(2)
    expect(run.all).toContain('this folder and vault NoTerminal both hold files')
    expect(run.all).toContain('choose --prefer merge, local or server')
    expect(readConfig(joiner)).toBeNull()
    expect(await devicesOn(server, 'NoTerminal')).toBe(before)
    // Nothing on the disk moved.
    expect(await read(joiner, 'Both.md')).toBe('joiner text\n')
  })
  it('refuses a --prefer it does not know', async () => {
    const { joiner } = await filledPair(server, 'Bogus')
    const run = await cli(initArgs(server, joiner, 'Bogus', 'joiner', ['--prefer', 'mine']), env)
    expect(run.code).toBe(2)
    expect(run.all).toContain('--prefer takes merge, local or server')
    expect(readConfig(joiner)).toBeNull()
  })
  it('asks at a terminal, and takes the answer', async () => {
    const { joiner } = await filledPair(server, 'Asked')
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const stderr = new PassThrough()
    const said: string[] = []
    stderr.on('data', (chunk: Buffer) => said.push(chunk.toString()))
    const out: string[] = []
    const io: CliIo = { out: (l) => out.push(l), err: (l) => out.push(l), stdin, stderr }
    const running = runCli(initArgs(server, joiner, 'Asked', 'joiner'), env, io)
    stdin.end('server\n')
    expect(await running, out.join('\n')).toBe(0)
    expect(said.join('')).toContain('both hold files')
    expect(config(joiner).joinPrefer).toBe('theirs')
  })

  it('init --force over a join that has not run yet keeps its choice, and asks nothing', async () => {
    const { joiner } = await filledPair(server, 'Forced')
    const first = await cli(
      initArgs(server, joiner, 'Forced', 'joiner', ['--prefer', 'server']),
      env
    )
    expect(first.code, first.all).toBe(0)
    const again = await cli(initArgs(server, joiner, 'Forced', 'joiner', ['--force']), env)
    expect(again.code, again.all).toBe(0)
    expect(config(joiner).joinPrefer).toBe('theirs')
  })
})
