import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EngineError } from '@abele/sync-core'
import { runCli } from '../../src/cli.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { stateDbFile } from '../../src/vault.js'
import {
  cleanupFolders,
  cli,
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

let server: SpawnedServer
let a: string, b: string
const code = (id: string, file = 'main.js') => `.obsidian/plugins/${id}/${file}`
beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  ;({ a, b } = await vaultPair(server, 'Grouped code approval'))
}, SETUP_MS)
afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

async function fingerprint(id: string): Promise<string> {
  const listed = await cli(['code', '--dir', b])
  expect(listed.code, listed.all).toBe(0)
  const line = listed.out.find((one) => one.startsWith(`plugin ${id} `))
  const value = /expect ([a-f0-9]+)/.exec(line ?? '')?.[1]
  expect(value, listed.all).toBeDefined()
  return value!
}
const entry = async (id: string) => {
  const state = SqliteStateStore.open(stateDbFile(b))
  try {
    return await state.get(code(id))
  } finally {
    state.close()
  }
}
async function prepare(id: string, updateMain = true) {
  await write(a, code(id), `${id}Before()`)
  await syncOnce(a)
  await syncOnce(b)
  const accepted = await cli([
    'code',
    '--dir',
    b,
    '--approve',
    id,
    '--expect',
    await fingerprint(id),
  ])
  expect(accepted.code, accepted.all).toBe(0)
  if (updateMain) await write(a, code(id), `${id}After()`)
  await write(a, code(id, 'manifest.json'), JSON.stringify({ id, version: '2.0.0' }))
  await write(a, code(id, 'styles.css'), 'body {}')
  await syncOnce(a)
  await syncOnce(b)
  const head = (await clientFor(a).manifest(null)).items.find(
    (one) => one.path === code(id, updateMain ? 'main.js' : 'manifest.json')
  )!
  return { shown: await fingerprint(id), head, before: await entry(id) }
}
async function approve(id: string, shown: string, fetchImpl: typeof fetch = fetch) {
  const out: string[] = [],
    err: string[] = []
  const result = await runCli(
    ['code', '--dir', b, '--approve', id, '--expect', shown],
    {},
    {
      fetch: fetchImpl,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    }
  )
  return { code: result, all: [...out, ...err].join('\n') }
}

describe('all-or-nothing plugin code approval', () => {
  it('refuses the displayed group when only a companion changes and retains every staged member', async () => {
    const id = 'stale-companion-group'
    const { shown, before } = await prepare(id)
    await write(a, code(id, 'manifest.json'), JSON.stringify({ id, version: '3.0.0' }))
    await syncOnce(a)
    await syncOnce(b)
    const current = await fingerprint(id)
    expect(current).not.toBe(shown)
    const refused = await approve(id, shown)
    expect(refused.code, refused.all).toBe(2)
    expect(refused.all).toContain('changed')
    expect(await read(b, code(id))).toBe(`${id}Before()`)
    expect(existsSync(join(b, code(id, 'manifest.json')))).toBe(false)
    expect(existsSync(join(b, code(id, 'styles.css')))).toBe(false)
    expect(await entry(id)).toEqual(before)
    expect(await fingerprint(id)).toBe(current)
    expect((await approve(id, current)).code).toBe(0)
    expect(await read(b, code(id, 'manifest.json'))).toContain('3.0.0')
  })

  for (const [mutation, updateMain] of [
    ['delete', true],
    ['edit', true],
    ['delete', false],
    ['edit', false],
  ] as const) {
    it(`keeps every member staged during a local ${mutation}, main update=${updateMain}`, async () => {
      const id = `download-${mutation}-${updateMain ? 'update' : 'companions'}`
      const { shown, head, before } = await prepare(id, updateMain)
      let injected = false
      const fetching: typeof fetch = async (input, init) => {
        const response = await fetch(input, init)
        if (!injected && String(input).endsWith(`/v1/blobs/${head.sha}`)) {
          injected = true
          if (mutation === 'delete') await rm(join(b, '.obsidian/plugins', id), { recursive: true })
          else await write(b, code(id), 'localEditDuringDownload()')
        }
        return response
      }
      const result = await approve(id, shown, fetching)
      expect(injected).toBe(true)
      expect(result.code, result.all).toBe(1)
      expect(result.all).toContain('still held')
      expect(existsSync(join(b, code(id, 'manifest.json')))).toBe(false)
      expect(existsSync(join(b, code(id, 'styles.css')))).toBe(false)
      if (mutation === 'delete') expect(existsSync(join(b, '.obsidian/plugins', id))).toBe(false)
      else expect(await read(b, code(id))).toBe('localEditDuringDownload()')
      expect(await entry(id)).toEqual(before)
      expect(await fingerprint(id)).toBe(shown)
    })
  }

  for (const cut of ['after-main', 'before-state-commit']) {
    it(`recovers the complete group after SIGKILL ${cut} before another sync`, async () => {
      const id = `killed-${cut}`
      const { shown, before } = await prepare(id)
      const child = fork(
        fileURLToPath(new URL('./helpers/codeApprovalChild.mjs', import.meta.url)),
        [b, id, shown, cut],
        { silent: true, execArgv: [] }
      )
      const exited = once(child, 'exit')
      let timer: ReturnType<typeof setTimeout> | undefined
      let stderr = ''
      child.stderr?.on('data', (data) => {
        stderr += String(data)
      })
      try {
        const message = await Promise.race([
          once(child, 'message').then(([value]) => value),
          exited.then(() => {
            throw new Error(`approval exited before ${cut}: ${stderr}`)
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`missing barrier ${cut}: ${stderr}`)), 5000)
          }),
        ])
        expect(message).toEqual({ barrier: cut })
        // WAL readers must still see the complete pending queue, not the speculative ledger.
        expect(await fingerprint(id)).toBe(shown)
        child.kill('SIGKILL')
        expect(await exited).toEqual([null, 'SIGKILL'])
      } finally {
        clearTimeout(timer)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        await exited
      }
      await syncOnce(b)
      expect(await read(b, code(id))).toBe(`${id}Before()`)
      expect(existsSync(join(b, code(id, 'manifest.json')))).toBe(false)
      expect(existsSync(join(b, code(id, 'styles.css')))).toBe(false)
      expect(await entry(id)).toEqual(before)
      expect(await fingerprint(id)).toBe(shown)
      expect((await approve(id, shown)).code).toBe(0)
      expect(await read(b, code(id))).toBe(`${id}After()`)
    })
  }

  it('rolls the files and ledger back if a later member cannot be placed, then retries the same group', async () => {
    const id = 'placement-failure'
    const { shown, before } = await prepare(id)
    const original = NodeFileSystem.prototype.writeAtomic
    let injected = false
    const fail = vi
      .spyOn(NodeFileSystem.prototype, 'writeAtomic')
      .mockImplementation(async function (this: NodeFileSystem, path, bytes, mtime) {
        if (
          !injected &&
          (this as unknown as { root: string }).root === b &&
          path === code(id, 'manifest.json')
        ) {
          injected = true
          throw new EngineError('io', 'injected placement failure')
        }
        await original.call(this, path, bytes, mtime)
      })
    try {
      const result = await approve(id, shown)
      expect(injected).toBe(true)
      expect(result.code, result.all).toBe(1)
    } finally {
      fail.mockRestore()
    }
    expect(await read(b, code(id))).toBe(`${id}Before()`)
    expect(existsSync(join(b, code(id, 'manifest.json')))).toBe(false)
    expect(existsSync(join(b, code(id, 'styles.css')))).toBe(false)
    expect(await entry(id)).toEqual(before)
    expect(await fingerprint(id)).toBe(shown)
    const retry = await approve(id, shown)
    expect(retry.code, retry.all).toBe(0)
    expect(await read(b, code(id))).toBe(`${id}After()`)
    expect(await read(b, code(id, 'manifest.json'))).toContain('2.0.0')
    expect(await read(b, code(id, 'styles.css'))).toBe('body {}')
  })
})
