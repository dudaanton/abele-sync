import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeText, selectiveDefaults, sha256 } from '@abele/sync-core'
import { runCli } from '../../src/cli.js'
import { readConfig, stateFolder, writeConfig } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import type { CliIo } from '../../src/context.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { ignoreFile, scopeKey, stateDbFile } from '../../src/vault.js'
import { tokenFor, connection } from '../helpers/token.js'

const AT = '2026-09-05T10:00:00.000Z'
const TOKEN = tokenFor('https://sync.example.com')
type Handler = (req: { url: URL; body: unknown }) => unknown
const json = (body: unknown, status = 200) => Response.json(body, { status })
function fakeServer(routes: Record<string, Handler>) {
  const calls: string[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const key = `${init?.method ?? 'GET'} ${url.pathname}`
    calls.push(key)
    const handler = routes[key]
    if (!handler)
      return json({ error: { code: 'not_found', message: `no fake route for ${key}` } }, 404)
    const answer = handler({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    if (answer instanceof Response) return answer
    if (answer instanceof Uint8Array) {
      const range = new Headers(init?.headers).get('range')
      if (range) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)
        if (!match) throw new Error(`invalid fake range: ${range}`)
        const start = Number(match[1]),
          end = Number(match[2])
        if (start > end || end >= answer.length)
          throw new Error(`out-of-bounds fake range: ${range}`)
        return new Response(answer.slice(start, end + 1) as Uint8Array<ArrayBuffer>, {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/${answer.length}` },
        })
      }
      return new Response(answer as Uint8Array<ArrayBuffer>)
    }
    return json(answer)
  }
  return { fetch: impl, calls }
}
it('the restore transport returns the exact requested inclusive range', async () => {
  const bytes = encodeText('back again\n')
  const fake = fakeServer({ 'GET /v2/files/f1/content': () => bytes })
  const response = await fake.fetch(
    'https://sync.example.com/v2/files/f1/content?version_id=ver2',
    {
      headers: { range: 'bytes=0-0' },
    }
  )
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe(`bytes 0-0/${bytes.length}`)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(0, 1))
})
class DeafSocket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}
interface Run {
  code: number
  out: string[]
  err: string[]
  all: string
}
function launch(argv: string[], fetchImpl = fetch, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [],
    err: string[] = []
  const io: CliIo = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetch: fetchImpl,
    WebSocket: DeafSocket as unknown as typeof WebSocket,
  }
  const done = runCli(argv, env, io).then((code) => ({
    code,
    out,
    err,
    all: [...out, ...err].join('\n'),
  }))
  return { done, out, err }
}
const cli = (args: string[], fetchImpl = fetch, env: NodeJS.ProcessEnv = {}) =>
  launch(args, fetchImpl, env).done
/** Emit only to in-process handlers. A setup failure must not send an OS signal to Vitest. */
async function until(started: ReturnType<typeof launch>, check: () => boolean) {
  let finished: Run | undefined
  void started.done.then((run) => {
    finished = run
  })
  const deadline = Date.now() + 5000
  while (!check() && !finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  if (check()) return
  if (!finished && process.listenerCount('SIGTERM')) process.emit('SIGTERM')
  const run = await started.done
  throw new Error(`daemon did not reach barrier:\n${run.all}`)
}
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-cli-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
function setUp() {
  writeConfig(dir, {
    serverUrl: connectionAddress,
    vaultId: 'v1',
    deviceId: 'd1',
    deviceToken: TOKEN,
    deviceName: 'daemon-test',
    selective: selectiveDefaults(),
  })
}
const connectionAddress = 'https://sync.example.com'
const empty = (cursor = 0): Record<string, Handler> => ({
  'GET /v2/connection': () => connection,
  'GET /v2/manifest': () => ({ items: [], next: null, cursor }),
  'GET /v2/changes': () => ({ items: [], next: null, cursor }),
})
async function withState<T>(fn: (state: SqliteStateStore) => Promise<T>): Promise<T> {
  const state = SqliteStateStore.open(stateDbFile(dir))
  try {
    return await fn(state)
  } finally {
    state.close()
  }
}
describe('command line and token connect', () => {
  it('answers help without doing anything', async () => {
    const run = await cli(['--help'])
    expect(run.code).toBe(0)
    expect(run.all).toContain('connect')
    expect(run.all).not.toContain('init --')
  })
  for (const args of [[], ['sing']])
    it(`refuses missing/unknown command ${args}`, async () => {
      const run = await cli(args)
      expect(run.code).toBe(2)
      expect(run.all).toContain('Usage:')
    })
  it('validates a token, writes a private config, and never prints either bearer spelling', async () => {
    const fake = fakeServer(empty())
    const run = await cli(['connect', '--dir', dir, '--token', TOKEN], fake.fetch)
    expect(run.code, run.all).toBe(0)
    expect(readConfig(dir)?.deviceToken).toBe(TOKEN)
    expect((await stat(join(stateFolder(dir), 'config.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(stateFolder(dir))).mode & 0o777).toBe(0o700)
    expect(run.all).not.toContain(TOKEN)
    expect(run.all).not.toContain('a'.repeat(43))
    expect(fake.calls).toEqual(['GET /v2/connection'])
  })
  it('accepts ABELE_TOKEN and refuses a missing token before any request', async () => {
    const fake = fakeServer(empty())
    expect((await cli(['connect', '--dir', dir], fake.fetch)).code).toBe(2)
    expect(fake.calls).toEqual([])
    const run = await cli(['connect', '--dir', dir], fake.fetch, { ABELE_TOKEN: TOKEN })
    expect(run.code, run.all).toBe(0)
    expect(run.all).not.toContain(TOKEN)
  })
  it('refuses to replace an existing config without requesting authority', async () => {
    setUp()
    const fake = fakeServer(empty())
    expect((await cli(['connect', '--dir', dir, '--token', TOKEN], fake.fetch)).code).toBe(2)
    expect(fake.calls).toEqual([])
  })
})
describe('run', () => {
  it('syncs once, reports and logs the summary', async () => {
    setUp()
    const run = await cli(['run', '--dir', dir, '--once'], fakeServer(empty()).fetch)
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.all).toContain('sync: done')
    expect(await readFile(join(stateFolder(dir), 'log'), 'utf8')).toContain('sync: done')
  })
  it('refuses an unconfigured directory', async () => {
    const run = await cli(['run', '--dir', dir, '--once'])
    expect(run.code).toBe(2)
    expect(run.all).toContain('connect')
  })
  it('does not run beside another daemon', async () => {
    setUp()
    const release = await acquireLock(dir)
    try {
      const run = await cli(['run', '--dir', dir, '--once'])
      expect(run.code).toBe(3)
      expect(run.all).toContain(String(process.pid))
    } finally {
      release()
    }
  })
  it('reports unreachable server and exits nonzero', async () => {
    setUp()
    const run = await cli(['run', '--dir', dir, '--once'], async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(run.code).toBe(1)
    expect(run.out).toEqual([])
    expect(run.all).toContain('never reached the server')
  })
  for (const command of [
    ['run', '--once'],
    ['restore', '--deleted', 'gone.md'],
  ])
    it(`drops the lock when the ledger cannot open: ${command[0]}`, async () => {
      setUp()
      await mkdir(stateDbFile(dir))
      const run = await cli([...command, '--dir', dir])
      expect(run.code).toBe(1)
      expect(run.all).toContain('state database')
      expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
    })
  for (const value of ['1', 'often'])
    it(`refuses invalid interval ${value}`, async () => {
      setUp()
      const run = await cli(['run', '--dir', dir, '--once', '--interval', value])
      expect(run.code).toBe(2)
    })
  it('rescans once for selective and ignore changes, not on ordinary idle runs', async () => {
    setUp()
    const cfg = readConfig(dir)!,
      fake = fakeServer(empty(3))
    const walks = () => fake.calls.filter((c) => c === 'GET /v2/manifest').length
    const once = async () => {
      const r = await cli(['run', '--dir', dir, '--once'], fake.fetch)
      expect(r.code, r.all).toBe(0)
    }
    await once()
    await once()
    expect(walks()).toBe(1)
    writeConfig(dir, { ...cfg, selective: { ...cfg.selective, video: false } })
    await once()
    await once()
    expect(walks()).toBe(2)
    await writeFile(ignoreFile(dir), '*.tmp\n')
    await once()
    expect(walks()).toBe(3)
    await writeFile(ignoreFile(dir), '')
    await once()
    expect(walks()).toBe(4)
    await rm(ignoreFile(dir))
    await once()
    await once()
    expect(walks()).toBe(5)
    expect(scopeKey(cfg.selective, '')).not.toBe(scopeKey(cfg.selective, null))
    expect(await readFile(join(stateFolder(dir), 'log'), 'utf8')).toContain(
      'rescan: what this device syncs changed'
    )
  })
})
describe('daemon loop', () => {
  it('records a changed scope only after a successful startup rescan', async () => {
    setUp()
    await withState(async (state) => {
      await state.setCursor(3)
      state.setMeta('scope', 'earlier')
    })
    let failures = 1
    const fake = fakeServer({
      ...empty(3),
      'GET /v2/manifest': () =>
        failures-- > 0
          ? json({ error: { code: 'internal', message: 'not now' } }, 500)
          : { items: [], next: null, cursor: 3 },
    })
    const session = async () => {
      const started = launch(['run', '--dir', dir], fake.fetch)
      await until(started, () => started.out.some((s) => s.startsWith('sync: done')))
      process.emit('SIGTERM')
      const run = await started.done
      expect(run.code, run.all).toBe(0)
      return run
    }
    expect((await session()).all).toContain('sync: failed')
    expect(await withState(async (s) => s.getMeta('scope'))).toBe('earlier')
    await session()
    expect(await withState(async (s) => s.getMeta('scope'))).toBe(
      scopeKey(readConfig(dir)!.selective, null)
    )
    const walks = fake.calls.filter((c) => c === 'GET /v2/manifest').length
    await session()
    expect(fake.calls.filter((c) => c === 'GET /v2/manifest')).toHaveLength(walks)
  })
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    it(`releases resources and handlers on ${signal}`, async () => {
      setUp()
      expect(process.listenerCount(signal)).toBe(0)
      const started = launch(['run', '--dir', dir], fakeServer(empty()).fetch)
      await until(started, () => started.out.some((s) => s.startsWith('state:')))
      expect(started.out[0]).toContain(`watching ${dir}`)
      expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(true)
      process.emit(signal)
      const run = await started.done
      expect(run.code).toBe(0)
      expect(run.err).toEqual([])
      expect(run.all).toContain(`stopping on ${signal}`)
      expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
      expect(process.listenerCount('SIGTERM')).toBe(0)
      expect(process.listenerCount('SIGINT')).toBe(0)
      expect(await readFile(join(stateFolder(dir), 'log'), 'utf8')).toContain(
        `stopping on ${signal}`
      )
    })
})
describe('status', () => {
  it('prints scope, cursor, head, pending and local summary without leaking the token', async () => {
    setUp()
    await writeFile(join(dir, 'fresh.md'), 'pending note')
    const run = await cli(['status', '--dir', dir], fakeServer(empty(7)).fetch)
    expect(run.code, run.all).toBe(0)
    for (const line of [
      'cursor     0',
      'head_seq   7',
      'pending    1',
      'last sync  never',
      'last error none',
      'scope      folder /',
    ])
      expect(run.all).toContain(line)
    expect(run.all).not.toContain(TOKEN)
  })
  it('counts no oversized file as pending', async () => {
    setUp()
    await writeFile(join(dir, 'big.md'), 'over ten bytes of note')
    await writeFile(join(dir, 'tiny.md'), 'ok')
    const run = await cli(
      ['status', '--dir', dir],
      fakeServer({
        ...empty(),
        'GET /v2/connection': () => ({
          ...connection,
          limits: { max_file_bytes: 10, quota_bytes: null },
        }),
      }).fetch
    )
    expect(run.code, run.all).toBe(0)
    expect(run.all).toContain('pending    1')
  })
})
const versions = [2, 1].map((n) => ({
  version_id: `ver${n}`,
  no: n,
  seq: n,
  op: n === 1 ? 'create' : 'modify',
  path: 'note.md',
  sha: (n === 1 ? 'a' : 'b').repeat(64),
  size: n * 10,
  mtime: n * 1000,
  actor: { kind: 'key', id: 'd1', name: 'laptop' },
  at: AT,
  merge: null,
}))
const head = {
  file_id: 'f1',
  path: 'note.md',
  kind: 'note',
  version_id: 'ver2',
  sha: 'b'.repeat(64),
  size: 20,
  mtime: 2000,
}
const found: Record<string, Handler> = {
  'GET /v2/manifest': () => ({ items: [head], next: null, cursor: 2 }),
  'GET /v2/files/f1/history': () => versions,
}
describe('history via v2', () => {
  it('lists newest first', async () => {
    setUp()
    const run = await cli(['history', '--dir', dir, 'note.md'], fakeServer(found).fetch)
    expect(run.code, run.all).toBe(0)
    expect(run.out[0]).toContain('ver2')
    expect(run.out[0]).toContain('#2')
    expect(run.out[0]).toContain('laptop')
    expect(run.out[0]).toContain('1970-01-01T00:00:02.000Z')
    expect(run.all).not.toContain(AT)
    expect(run.out[1]).toContain('ver1')
    expect(run.out[1]).toContain('1970-01-01T00:00:01.000Z')
  })
  for (const binary of [false, true])
    it(`diffs ${binary ? 'binary' : 'text'} versions with file/version authorization`, async () => {
      setUp()
      const fake = fakeServer({
        ...found,
        'GET /v2/files/f1/content': ({ url }) =>
          url.searchParams.get('version_id') === 'ver1'
            ? binary
              ? new Uint8Array([0, 1, 2])
              : encodeText('one\ntwo\nthree\n')
            : binary
              ? new Uint8Array([0, 1, 2, 3])
              : encodeText('one\ntwo point five\nthree\n'),
      })
      const run = await cli(['history', '--dir', dir, 'note.md', '--diff', '1', '2'], fake.fetch)
      expect(run.code, run.all).toBe(0)
      if (binary) expect(run.all).toContain('binary versions differ')
      else for (const s of ['@@', '-two', '+two point five', ' three']) expect(run.all).toContain(s)
    })
  it('refuses a missing diff argument before requests', async () => {
    setUp()
    const fake = fakeServer(found),
      run = await cli(['history', '--dir', dir, 'note.md', '--diff', 'ver1'], fake.fetch)
    expect(run.code).toBe(2)
    expect(run.all).toContain('two versions')
    expect(fake.calls).toEqual([])
  })
  it('refuses an unknown version', async () => {
    setUp()
    const run = await cli(
      ['history', '--dir', dir, 'note.md', '--diff', 'ver1', 'ver9'],
      fakeServer(found).fetch
    )
    expect(run.code).toBe(2)
    expect(run.all).toContain('ver9')
  })
})
const trash = [
  {
    file_id: 'f1',
    path: 'gone.md',
    kind: 'note',
    deleted_at: AT,
    last_version_id: 'ver1',
    size: 4,
  },
]
const restored = {
  status: 'applied',
  file_id: 'f1',
  version_id: 'ver2',
  seq: 2,
  path: 'gone.md',
  sha: 'a'.repeat(64),
  size: 4,
  mtime: 1000,
}
describe('restore via v2', () => {
  it('restores deleted bytes and syncs them onto disk', async () => {
    setUp()
    const bytes = encodeText('back again\n'),
      sha = await sha256(bytes)
    let done = false
    const fake = fakeServer({
      ...empty(2),
      'GET /v2/trash': () => trash,
      'POST /v2/files/f1/restore': () => {
        done = true
        return { ...restored, sha, size: bytes.length }
      },
      'GET /v2/manifest': () => ({
        items: done ? [{ ...head, path: 'gone.md', sha, size: bytes.length }] : [],
        next: null,
        cursor: 2,
      }),
      'GET /v2/files/f1/content': () => bytes,
    })
    const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md'], fake.fetch)
    expect(run.code, run.all).toBe(0)
    expect(run.err).toEqual([])
    expect(run.all).toContain('restored gone.md')
    expect(await readFile(join(dir, 'gone.md'), 'utf8')).toBe('back again\n')
  })
  it('reports no deleted file at the requested path', async () => {
    setUp()
    const run = await cli(
      ['restore', '--dir', dir, '--deleted', 'gone.md'],
      fakeServer({ 'GET /v2/trash': () => [] }).fetch
    )
    expect(run.code).toBe(2)
    expect(run.all).toContain('gone.md')
  })
  for (const flags of [[], ['--deleted', 'gone.md', '--version', 'ver1']])
    it(`rejects missing or contradictory restore arguments ${flags}`, async () => {
      setUp()
      const fake = fakeServer({}),
        run = await cli(['restore', '--dir', dir, ...flags], fake.fetch)
      expect(run.code).toBe(2)
      expect(fake.calls).toEqual([])
    })
  it('restores beside a daemon without touching its disk or lock', async () => {
    setUp()
    const release = await acquireLock(dir)
    try {
      const fake = fakeServer({
        'GET /v2/trash': () => trash,
        'POST /v2/files/f1/restore': () => restored,
      })
      const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md'], fake.fetch)
      expect(run.code, run.all).toBe(0)
      expect(run.all).toContain('on the server; the daemon will bring it down')
      expect(existsSync(join(dir, 'gone.md'))).toBe(false)
      expect((await readFile(join(stateFolder(dir), 'lock'), 'utf8')).split('\n')[0]).toBe(
        String(process.pid)
      )
      await expect(acquireLock(dir)).rejects.toThrow(/another abele-sync is running/)
      expect(fake.calls.some((c) => c.includes('/manifest') || c.includes('/changes'))).toBe(false)
    } finally {
      release()
    }
  })
})
const revoked: Handler = () =>
  json({ error: { code: 'unauthorized', message: 'token revoked' } }, 401)
const denied = {
  'GET /v2/connection': revoked,
  'GET /v2/manifest': revoked,
  'GET /v2/changes': revoked,
}
const hint = 'disconnect locally and connect with a new token'
describe('revoked token', () => {
  for (const once of [true, false])
    it(`stops ${once ? 'once' : 'daemon'} with the hint and releases handlers/lock`, async () => {
      setUp()
      const run = await cli(
        ['run', '--dir', dir, ...(once ? ['--once'] : [])],
        fakeServer(denied).fetch
      )
      expect(run.code, run.all).toBe(4)
      expect(run.all).toContain(hint)
      expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
      expect(process.listenerCount('SIGTERM')).toBe(0)
      expect(process.listenerCount('SIGINT')).toBe(0)
      if (!once)
        expect(
          (await readFile(join(stateFolder(dir), 'log'), 'utf8')).match(/failed: /g)
        ).toHaveLength(1)
    })
  it('reports locally persisted revocation without requests or printing credentials', async () => {
    setUp()
    const fake = fakeServer(denied)
    expect((await cli(['run', '--dir', dir, '--once'], fake.fetch)).code).toBe(4)
    const count = fake.calls.length,
      run = await cli(['status', '--dir', dir], fake.fetch)
    expect(run.code).toBe(0)
    expect(run.all).toMatch(/state\s+revoked/)
    expect(fake.calls).toHaveLength(count)
    expect(run.all).not.toContain(TOKEN)
  })
  it('status gives recovery advice on first authorization refusal', async () => {
    setUp()
    const run = await cli(['status', '--dir', dir], fakeServer(denied).fetch)
    expect(run.code).toBe(1)
    expect(run.all).toContain(hint)
    expect(run.all).not.toContain(TOKEN)
  })
})
describe('retained temp files', () => {
  const leftover = () => join(stateFolder(dir), 'tmp', 'half-written')
  it('leaves temp data alone in status/history but sweeps it on an owned run', async () => {
    setUp()
    await mkdir(join(stateFolder(dir), 'tmp'), { recursive: true })
    await writeFile(leftover(), 'retained')
    const fake = fakeServer({ ...empty(), 'GET /v2/trash': () => [] })
    expect((await cli(['status', '--dir', dir], fake.fetch)).code).toBe(0)
    expect(existsSync(leftover())).toBe(true)
    expect((await cli(['history', '--dir', dir, 'nowhere.md'], fake.fetch)).code).toBe(2)
    expect(existsSync(leftover())).toBe(true)
    expect((await cli(['run', '--dir', dir, '--once'], fake.fetch)).code).toBe(0)
    expect(existsSync(leftover())).toBe(false)
  })
})
it('persists summary and refusals for local status', async () => {
  setUp()
  const note = 'thirty bytes of note, or so..'
  await writeFile(join(dir, 'big.md'), note)
  const fake = fakeServer({
    ...empty(),
    [`PUT /v2/uploads/${await sha256(encodeText(note))}`]: () =>
      new Response(null, { status: 204 }),
    'POST /v2/commit': () => ({
      cursor: 0,
      results: [
        { status: 'rejected', code: 'too_large', message: 'the file is 30 bytes; the limit is 10' },
      ],
    }),
  })
  const started = launch(['run', '--dir', dir], fake.fetch)
  await until(started, () => started.out.some((s) => s.startsWith('sync: done (pulled')))
  process.emit('SIGTERM')
  const run = await started.done
  expect(run.code, run.all).toBe(0)
  const summary = run.out.find((s) => s.startsWith('sync: done (pulled'))!
  expect(summary).toContain('rejected 1')
  const log = await readFile(join(stateFolder(dir), 'log'), 'utf8')
  expect(log).toContain(summary)
  expect(log).toContain('push: create refused: too_large')
  const status = await cli(['status', '--dir', dir], fake.fetch)
  expect(status.code, status.all).toBe(0)
  expect(status.all).toContain(`summary    ${summary}`)
  expect(status.all).toContain('refused    push: create refused: too_large')
})
it('prints server errors as a single sanitized line', async () => {
  setUp()
  const fake = fakeServer({
    'GET /v2/connection': () =>
      json(
        {
          error: {
            code: 'internal',
            message: 'one\u001b[31m line\nsync: done (pulled 9)\r\u0007and no more',
          },
        },
        500
      ),
  })
  const run = await cli(['status', '--dir', dir], fake.fetch)
  expect(run.code).toBe(1)
  expect(run.err).toEqual(['one[31m line sync: done (pulled 9) and no more'])
})
