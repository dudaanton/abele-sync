import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  unlinkSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import SqliteDatabase from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli.js'
import { SCOPED_LIMITS, SCOPED_REQUIRED_CAPABILITIES } from '@abele/sync-protocol'
import { acquireLock } from '../../src/lock.js'
const dirs: string[] = [],
  token = `absk_${'a'.repeat(43)}`
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(prefix = 'Agents/') {
  const scratch = resolve(process.cwd(), 'data')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'agent-test-'))
  dirs.push(dir)
  const out: string[] = [],
    err: string[] = [],
    requests: string[] = []
  const blobs = new Map<string, Uint8Array>(),
    files: Array<{
      file_id: string
      version_id: string
      path: string
      kind: 'note' | 'attachment'
      sha: string
      size: number
      mtime: number
    }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/capabilities'))
      return new Response(
        JSON.stringify({
          protocol_version: 1,
          device: true,
          scoped: {
            enabled: true,
            protocol_version: 4,
            modes: { folder: true, group: false },
            features: Object.fromEntries(SCOPED_REQUIRED_CAPABILITIES.map((name) => [name, true])),
            limits: SCOPED_LIMITS,
          },
        })
      )
    if (url.endsWith('/state'))
      return new Response(
        JSON.stringify({
          endpoint_identity: 'https://issuer.example.test',
          vault_id: 'vault',
          grant_id: 'grant',
          principal_kind: 'key',
          principal_id: 'key',
          role: 'editor',
          state: 'active',
          selector: { kind: 'folder', prefix },
        })
      )
    if (url.endsWith('/snapshots'))
      return new Response(
        JSON.stringify({
          snapshot_id: 'snapshot',
          items: files,
          cursor: 'cursor',
          next_cursor: null,
          checkpoint: { kind: 'scoped', token: 'checkpoint' },
          feed_checkpoint: { kind: 'scoped', token: 'checkpoint' },
        })
      )
    if (url.endsWith('/self') && init?.method === 'DELETE')
      return new Response(JSON.stringify({ revoked: true }))
    if (url.endsWith('/feed'))
      return new Response(
        JSON.stringify({
          events: [],
          checkpoint: { kind: 'scoped', token: 'checkpoint' },
          has_more: false,
        })
      )
    if (url.includes('/uploads/') && init?.method === 'PUT') {
      const sha = url.split('/').at(-1)!
      const body = init.body as Uint8Array
      blobs.set(sha, new Uint8Array(body))
      return new Response(JSON.stringify({ sha, size: body.length }), { status: 201 })
    }
    if (url.endsWith('/commit')) {
      const request = JSON.parse(String(init?.body)),
        results = request.ops.map((op: any, index: number) => {
          const id = op.file_id ?? `created-${files.length + index}`,
            file = {
              file_id: id,
              version_id: `version-${crypto.randomUUID()}`,
              path: op.path ?? files.find((f) => f.file_id === id)?.path,
              kind: (op.path ?? '').endsWith('.md') ? ('note' as const) : ('attachment' as const),
              sha: op.sha,
              size: op.size,
              mtime: op.mtime,
            }
          const before = files.findIndex((f) => f.file_id === id)
          if (before >= 0) files[before] = file
          else files.push(file)
          const { kind: _kind, ...result } = file
          return { status: 'applied', ...result }
        })
      return new Response(
        JSON.stringify({ outcome_id: request.request_id, acknowledged: false, results })
      )
    }
    if (url.includes('/versions/')) {
      const file = files.find((f) => url.includes(`/files/${f.file_id}/`))
      if (file) return new Response(blobs.get(file.sha) as Uint8Array<ArrayBuffer>)
    }
    return new Response(null, { status: 204 })
  })
  const io = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    fetch: fetchMock as typeof fetch,
  }
  const setup = () =>
    runCli(
      [
        'agent',
        'setup',
        '--dir',
        dir,
        '--server',
        'https://issuer.example.test',
        '--vault',
        'vault',
        '--grant',
        'grant',
        '--principal',
        'key',
      ],
      { ABELE_AGENT_TOKEN: token },
      io
    )
  return { dir, out, err, requests, io, setup, fetchMock }
}
it('BUG: successful scoped publication prunes empty staging directories and permits ordinary disconnect', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  writeFileSync(join(f.dir, 'Agents', 'published.md'), 'published content')
  expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  const raw = new SqliteDatabase(join(f.dir, '.abele-sync', 'agent.sqlite'), { readonly: true })
  try {
    expect(
      JSON.parse(
        (
          raw.prepare("SELECT value FROM meta WHERE key = 'daemon:scoped-v4-state'").get() as {
            value: string
          }
        ).value
      ).journal
    ).toBeNull()
  } finally {
    raw.close()
  }
  expect(existsSync(join(f.dir, '.abele-sync', 'scoped-outbox'))).toBe(false)
  expect(await runCli(['agent', 'disconnect', '--dir', f.dir], {}, f.io)).toBe(0)
  expect(readFileSync(join(f.dir, 'Agents', 'published.md'), 'utf8')).toBe('published content')
})
for (const phase of ['state', 'feed', 'uploads', 'commit'])
  it(`stops with a distinct revoked status during ${phase}, preserving local and pending work`, async () => {
    const f = fixture()
    expect(await f.setup()).toBe(0)
    expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
    writeFileSync(join(f.dir, 'Agents', 'unsent.md'), 'keep this local edit')
    const previous = f.fetchMock.getMockImplementation()!
    f.fetchMock.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (phase === 'uploads' ? path.includes('/uploads/') : path.endsWith('/' + phase))
        return new Response(
          JSON.stringify({
            error: {
              code: 'unauthorized',
              message: 'scoped authority is unavailable',
              details: {},
            },
          }),
          { status: 401 }
        )
      return previous(input, init)
    })
    const handlers = ['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))
    expect(await runCli(['agent', 'run', '--dir', f.dir], {}, f.io)).toBe(4)
    expect(f.err.join('\n')).toMatch(/key.*revoked/)
    expect(readFileSync(join(f.dir, '.abele-sync', 'log'), 'utf8')).toMatch(/key.*revoked/)
    expect(readFileSync(join(f.dir, 'Agents', 'unsent.md'), 'utf8')).toBe('keep this local edit')
    expect(readdirSync(join(f.dir, '.abele-sync'))).not.toContain('lock')
    expect(['SIGTERM', 'SIGINT'].map((signal) => process.listenerCount(signal))).toEqual(handlers)
    const calls = f.fetchMock.mock.calls.length
    expect(await runCli(['agent', 'status', '--dir', f.dir], {}, f.io)).toBe(0)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ state: 'revoked' })
    if (phase === 'commit') expect(JSON.parse(f.out.at(-1)!).pending_request).not.toBeNull()
    expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(4)
    expect(f.fetchMock.mock.calls).toHaveLength(calls)
    if (phase === 'state') {
      for (const mapped of ['0', '1']) {
        const child = spawnSync(
          process.execPath,
          [
            resolve(import.meta.dirname, '../../dist/index.js'),
            'agent',
            'run',
            '--dir',
            f.dir,
            '--once',
          ],
          {
            env: { ...process.env, ABELE_REVOKED_EXIT_ZERO: mapped },
            encoding: 'utf8',
            timeout: 5000,
          }
        )
        expect(child.status, child.stderr).toBe(mapped === '1' ? 0 : 4)
        expect(child.stderr).toMatch(/key.*revoked/)
      }
    }
    expect(f.out.join('\n') + f.err.join('\n')).not.toContain(token)
  })
for (const failure of ['offline', 'internal'])
  it(`does not mark an ordinary ${failure} failure as revoked and allows a retry`, async () => {
    const f = fixture()
    expect(await f.setup()).toBe(0)
    const previous = f.fetchMock.getMockImplementation()!
    f.fetchMock.mockImplementation(async () => {
      if (failure === 'offline') throw new Error('network unavailable')
      return new Response(
        JSON.stringify({ error: { code: 'internal', message: 'internal error', details: {} } }),
        { status: 500 }
      )
    })
    expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(1)
    expect(await runCli(['agent', 'status', '--dir', f.dir], {}, f.io)).toBe(0)
    expect(JSON.parse(f.out.at(-1)!)).not.toHaveProperty('state', 'revoked')
    f.fetchMock.mockImplementation(previous)
    expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  })
it('reads a committed agent status snapshot beside a live writer without acquiring its lock or fetching', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  writeFileSync(join(f.dir, 'Agents', 'note.md'), 'content')
  expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  const lock = await acquireLock(f.dir)
  const db = new SqliteDatabase(join(f.dir, '.abele-sync', 'agent.sqlite'))
  const beforeLock = readFileSync(join(f.dir, '.abele-sync', 'lock'), 'utf8')
  const beforeConfig = readFileSync(join(f.dir, '.abele-sync', 'agent.json'), 'utf8')
  f.fetchMock.mockRejectedValue(new Error('status must work offline'))
  f.requests.length = 0
  try {
    db.exec('BEGIN IMMEDIATE')
    const key = 'daemon:scoped-v4-file:created-0'
    const value = JSON.parse(
      (db.prepare('select value from meta where key = ?').get(key) as { value: string }).value
    )
    db.prepare('update meta set value = ? where key = ?').run(
      JSON.stringify({ ...value, dirty: true }),
      key
    )
    const writerBytes = readFileSync(join(f.dir, '.abele-sync', 'agent.sqlite'))
    expect(await runCli(['agent', 'status', '--dir', f.dir], {}, f.io)).toBe(0)
    expect(JSON.parse(f.out.at(-1)!)).toEqual({
      mode: 'agent',
      scriptPolicy: 'refuse',
      vault: 'vault',
      grant: 'grant',
      received: 1,
      detached: 0,
      held: 0,
      pending_request: null,
    })
    expect(readFileSync(join(f.dir, '.abele-sync', 'agent.sqlite'))).toEqual(writerBytes)
    expect(readFileSync(join(f.dir, '.abele-sync', 'lock'), 'utf8')).toBe(beforeLock)
    expect(readFileSync(join(f.dir, '.abele-sync', 'agent.json'), 'utf8')).toBe(beforeConfig)
    expect(f.requests).toEqual([])
    expect(f.err).toEqual([])
    db.exec('COMMIT')
    expect(await runCli(['agent', 'status', '--dir', f.dir], {}, f.io)).toBe(0)
    expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ received: 1, held: 1 })
    expect(f.out.join('\n')).not.toContain(token)
  } finally {
    db.close()
    lock()
  }
})
it('refuses missing or mismatched agent ledgers during status without creating or repairing state', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  const configFile = join(f.dir, '.abele-sync', 'agent.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.binding.vault_id = 'other-vault'
  writeFileSync(configFile, JSON.stringify(config))
  expect(await runCli(['agent', 'status', '--dir', f.dir], {}, f.io)).toBe(1)
  expect(f.err.at(-1)).toMatch(/recovery/)
  unlinkSync(join(f.dir, '.abele-sync', 'agent.sqlite'))
  const before = readdirSync(join(f.dir, '.abele-sync'))
  expect(await runCli(['agent', 'status', '--dir', f.dir], {}, f.io)).toBe(1)
  expect(readdirSync(join(f.dir, '.abele-sync'))).toEqual(before)
})
it('refuses restore and disconnect beside a running writer and preserves bytes/state on locked maintenance', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  const lock = await acquireLock(f.dir)
  try {
    expect(
      await runCli(
        ['agent', 'restore', 'Agents/note.md', '--version', 'old', '--dir', f.dir],
        {},
        f.io
      )
    ).toBe(3)
    expect(await runCli(['agent', 'disconnect', '--dir', f.dir], {}, f.io)).toBe(3)
  } finally {
    lock()
  }
  expect(readFileSync(join(f.dir, '.abele-sync', 'agent.json'), 'utf8')).toContain('agent')
})
it('disconnects only through the scoped self route, retaining local state and preventing a personal rejoin', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  writeFileSync(join(f.dir, 'Agents', 'unsent.md'), 'keep this')
  expect(await runCli(['agent', 'disconnect', '--dir', f.dir], {}, f.io)).toBe(0)
  expect(f.requests.at(-1)).toBe(
    'https://issuer.example.test/v1/scoped/vaults/vault/grants/grant/self'
  )
  expect(readFileSync(join(f.dir, 'Agents', 'unsent.md'), 'utf8')).toBe('keep this')
  expect(statSync(join(f.dir, '.abele-sync', 'agent.sqlite')).isFile()).toBe(true)
  expect(
    await runCli(
      [
        'init',
        '--dir',
        f.dir,
        '--server',
        'https://issuer.example.test',
        '--email',
        'owner@example.test',
        '--force',
      ],
      {},
      f.io
    )
  ).not.toBe(0)
})
it('uses filtered scoped history and refuses a stale restore before any new commit', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  writeFileSync(join(f.dir, 'Agents', 'note.md'), 'content')
  expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  const previous = f.fetchMock.getMockImplementation()!
  f.fetchMock.mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/versions'))
      return new Response(JSON.stringify({ items: [], next_cursor: null }))
    return previous(input, init)
  })
  const count = f.requests.filter((url) => url.endsWith('/commit')).length
  expect(await runCli(['agent', 'history', 'Agents/note.md', '--dir', f.dir], {}, f.io)).toBe(0)
  expect(
    await runCli(
      ['agent', 'restore', 'Agents/note.md', '--version', 'private-or-pruned', '--dir', f.dir],
      {},
      f.io
    )
  ).not.toBe(0)
  expect(f.requests.filter((url) => url.endsWith('/commit'))).toHaveLength(count)
  expect(readFileSync(join(f.dir, 'Agents', 'note.md'), 'utf8')).toBe('content')
})
for (const disconnected of [false, true])
  it(`refuses forced personal init before sending valid owner credentials with ${disconnected ? 'disconnected' : 'live'} agent state`, async () => {
    const f = fixture()
    expect(await f.setup()).toBe(0)
    if (disconnected)
      expect(await runCli(['agent', 'disconnect', '--dir', f.dir], {}, f.io)).toBe(0)
    f.requests.length = 0
    expect(
      await runCli(
        [
          'init',
          '--force',
          '--prefer',
          'merge',
          '--dir',
          f.dir,
          '--server',
          'https://issuer.example.test',
          '--email',
          'owner@example.test',
          '--password',
          'valid-fixture-password',
        ],
        {},
        f.io
      )
    ).not.toBe(0)
    expect(f.requests).toEqual([])
    expect(f.err.join('\n')).toMatch(/agent/)
  })
it('sets up a scoped-only bound SQLite ledger and runs polling with no personal credential or route', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  const config = JSON.parse(readFileSync(join(f.dir, '.abele-sync', 'agent.json'), 'utf8'))
  expect(config).toMatchObject({ mode: 'agent', scriptPolicy: 'refuse' })
  expect(config).not.toHaveProperty('deviceToken')
  expect(statSync(join(f.dir, '.abele-sync', 'agent.json')).mode & 0o777).toBe(0o600)
  expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  expect(
    f.requests.every((url) => url.endsWith('/capabilities') || url.includes('/v1/scoped/'))
  ).toBe(true)
  expect(f.out.join('\n')).not.toContain(token)
})
it('creates and settles a folder-native attachment through scoped upload/commit paths on the actual SQLite ledger', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  writeFileSync(join(f.dir, 'Agents', 'new.png'), 'image')
  expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  expect(f.requests.some((url) => url.includes('/uploads/'))).toBe(true)
  expect(f.requests.some((url) => url.endsWith('/commit'))).toBe(true)
  expect(readFileSync(join(f.dir, 'Agents', 'new.png'), 'utf8')).toBe('image')
  expect(f.err).toEqual([])
})
it('rejects a stripped-prefix directory and wrong grant before saving credentials', async () => {
  const f = fixture()
  writeFileSync(join(f.dir, 'task.md'), 'wrong root')
  expect(await f.setup()).not.toBe(0)
  const g = fixture('Other/')
  expect(await g.setup()).not.toBe(0)
  expect(g.err.join('\n')).toMatch(/Agents/)
})
it('shares the physical vault lock and does not upload out-of-scope, settings or script files', async () => {
  const f = fixture()
  expect(await f.setup()).toBe(0)
  mkdirSync(join(f.dir, 'Private'))
  writeFileSync(join(f.dir, 'Private', 'hidden.md'), 'private')
  writeFileSync(join(f.dir, 'Agents', 'script.js'), 'unsafe')
  const lock = await acquireLock(f.dir)
  try {
    expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(3)
  } finally {
    lock()
  }
  expect(await runCli(['agent', 'run', '--dir', f.dir, '--once'], {}, f.io)).toBe(0)
  expect(f.requests.some((url) => url.includes('/uploads/') || url.endsWith('/commit'))).toBe(false)
})
