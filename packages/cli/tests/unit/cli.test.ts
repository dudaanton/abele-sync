import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeText, selectiveDefaults, sha256 } from '@abele/sync-core'
import { runCli } from '../../src/cli.js'
import { readConfig, stateFolder, writeConfig } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import type { CliIo } from '../../src/context.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { ignoreFile, scopeKey, stateDbFile } from '../../src/vault.js'

/**
 * The program on fakes: a `fetch` that answers the routes each command uses, a temporary
 * directory for the vault, and the lines the command printed. Nothing here starts a server;
 * `tests/e2e` does that against the real one.
 */

const AT = '2026-09-05T10:00:00.000Z'
const USAGE = {
  live_bytes: 4096,
  history_bytes: 1024,
  trash_bytes: 0,
  quota_bytes: null,
  by_kind: {},
}
const DEVICE_TOKEN = 'absd_never_printed'
const PASSWORD = 'hunter2-never-printed'

/** What a fake route answers with: a body to encode as json, bytes, or a whole response. */
type Answer = unknown
type Handler = (req: { url: URL; body: unknown }) => Answer

interface Fake {
  fetch: typeof fetch
  calls: string[]
}

function fakeServer(routes: Record<string, Handler>): Fake {
  const calls: string[] = []
  const impl: typeof fetch = async (input, init) => {
    const href =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const url = new URL(href)
    const method = (init?.method ?? 'GET').toUpperCase()
    const key = `${method} ${url.pathname}`
    calls.push(key)
    const handler = routes[key]
    if (handler === undefined) {
      return json({ error: { code: 'not_found', message: `no fake route for ${key}` } }, 404)
    }
    const answer = handler({ url, body: bodyOf(init?.body) })
    if (answer instanceof Response) return answer
    // A body of bytes wants a view onto an `ArrayBuffer`, which every fixture here is.
    if (answer instanceof Uint8Array) {
      return new Response(answer as Uint8Array<ArrayBuffer>, { status: 200 })
    }
    return json(answer, 200)
  }
  return { fetch: impl, calls }
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function bodyOf(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return null
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

interface Run {
  code: number
  out: string[]
  err: string[]
  /** Everything the command printed, for the checks that no secret is among it. */
  all: string
}

interface Options {
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  WebSocket?: typeof WebSocket
  stdin?: CliIo['stdin']
  stderr?: NodeJS.WritableStream
}

interface Launched {
  done: Promise<Run>
  /** The lines so far, for a command that has not finished yet. */
  out: string[]
  err: string[]
}

/** Starts a command and hands back its lines as they arrive: for `run` without `--once`. */
function launch(argv: string[], opts: Options = {}): Launched {
  const out: string[] = []
  const err: string[] = []
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) }
  if (opts.fetch) io.fetch = opts.fetch
  if (opts.WebSocket) io.WebSocket = opts.WebSocket
  if (opts.stdin) io.stdin = opts.stdin
  if (opts.stderr) io.stderr = opts.stderr
  const done = runCli(argv, opts.env ?? {}, io).then((code) => ({
    code,
    out,
    err,
    all: [...out, ...err].join('\n'),
  }))
  return { done, out, err }
}

const cli = (argv: string[], opts: Options = {}): Promise<Run> => launch(argv, opts).done

/**
 * Waits for the daemon to have got somewhere, rather than for a guessed number of milliseconds.
 * One that never gets there is told to stop before the failure is thrown, so the test fails on
 * what the daemon printed instead of hanging on a signal nobody sends.
 */
async function until(started: Launched, done: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  if (done()) return
  process.kill(process.pid, 'SIGTERM')
  const run = await started.done
  throw new Error(`the daemon never got that far; it printed:\n${run.all}`)
}

/**
 * A socket that never opens and never says anything. The daemon subscribes to the event stream
 * on `start()`, and a test has no server to open one against; without this the engine would try
 * to reach `sync.example.com` for real.
 */
class DeafSocket {
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {}
}

const DEAF = DeafSocket as unknown as typeof WebSocket

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A vault that has already been set up, so a command has something to open. */
async function setUp(): Promise<void> {
  writeConfig(dir, {
    serverUrl: 'https://sync.example.com',
    vaultId: 'v1',
    deviceId: 'd1',
    deviceToken: DEVICE_TOKEN,
    deviceName: 'daemon-test',
    selective: selectiveDefaults(),
  })
}

const enrolment: Record<string, Handler> = {
  'POST /v1/auth/login': () => ({ account_token: 'abst_test', expires_at: AT }),
  'POST /v1/devices': () => ({ device_id: 'd1', device_token: DEVICE_TOKEN }),
}

const vault = (name: string): unknown => ({ id: 'v1', name, role: 'owner', usage: USAGE })

/** A vault with nothing in it: what one sync of an empty folder asks the server for. */
const EMPTY_VAULT: Record<string, Handler> = {
  'GET /v1/vaults/v1/state': () => ({ head_seq: 0, settings: {}, usage: USAGE }),
  'GET /v1/vaults/v1/manifest': () => ({ items: [], next: null, head_seq: 0 }),
  'GET /v1/vaults/v1/changes': () => ({ items: [], head_seq: 0, next_since: 0 }),
}

/** A vault three commits in, with nothing new: a device at cursor 3 has only the feed to ask. */
const SETTLED_VAULT: Record<string, Handler> = {
  'GET /v1/vaults/v1/state': () => ({ head_seq: 3, settings: {}, usage: USAGE }),
  'GET /v1/vaults/v1/manifest': () => ({ items: [], next: null, head_seq: 3 }),
  'GET /v1/vaults/v1/changes': () => ({ items: [], head_seq: 3, next_since: 3 }),
}

/** Reads or writes the daemon's state database, closed again before the daemon opens it. */
async function withState<T>(fn: (state: SqliteStateStore) => Promise<T>): Promise<T> {
  const state = SqliteStateStore.open(stateDbFile(dir))
  try {
    return await fn(state)
  } finally {
    state.close()
  }
}

describe('the command line', () => {
  it('answers --help without doing anything', async () => {
    const run = await cli(['--help'])
    expect(run.code).toBe(0)
    expect(run.all).toContain('abele-sync')
    expect(run.all).toContain('init')
  })

  it('refuses a command it does not have, with the usage', async () => {
    const run = await cli(['sing'])
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain("unknown command 'sing'")
    expect(run.err.join('\n')).toContain('Usage:')
  })

  it('refuses no command at all, with the usage', async () => {
    const run = await cli([])
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('Usage:')
  })
})

describe('init', () => {
  it('logs in, enrols and writes a config nobody else can read', async () => {
    const fake = fakeServer({ ...enrolment, 'GET /v1/vaults': () => [vault('Notes')] })
    const run = await cli(
      [
        'init',
        '--server',
        'https://sync.example.com',
        '--dir',
        dir,
        '--email',
        'someone@example.com',
        '--password',
        PASSWORD,
      ],
      { fetch: fake.fetch }
    )

    expect(run.code).toBe(0)
    const cfg = readConfig(dir)
    expect(cfg?.vaultId).toBe('v1')
    expect(cfg?.deviceToken).toBe(DEVICE_TOKEN)
    const mode = (await stat(join(stateFolder(dir), 'config.json'))).mode & 0o777
    expect(mode).toBe(0o600)
    expect(run.all).not.toContain(DEVICE_TOKEN)
    expect(run.all).not.toContain(PASSWORD)
  })

  it('takes the password from ABELE_PASSWORD and never prints it', async () => {
    const fake = fakeServer({ ...enrolment, 'GET /v1/vaults': () => [vault('Notes')] })
    const run = await cli(['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c'], {
      fetch: fake.fetch,
      env: { ABELE_PASSWORD: PASSWORD },
    })
    expect(run.code).toBe(0)
    expect(run.all).not.toContain(PASSWORD)
    expect(readConfig(dir)?.deviceToken).toBe(DEVICE_TOKEN)
  })

  it('asks for a password when neither the flag nor the environment has one', async () => {
    const fake = fakeServer(enrolment)
    const run = await cli(['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c'], {
      fetch: fake.fetch,
    })
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('ABELE_PASSWORD')
    expect(fake.calls).toEqual([])
  })

  it('creates a vault named after the directory when the account has none', async () => {
    let created: unknown = null
    const fake = fakeServer({
      ...enrolment,
      'GET /v1/vaults': () => [],
      'POST /v1/vaults': ({ body }) => {
        created = body
        return { id: 'v1' }
      },
    })
    const run = await cli(
      ['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c', '--password', PASSWORD],
      { fetch: fake.fetch }
    )
    expect(run.code).toBe(0)
    expect(created).toEqual({ name: basename(dir) })
  })

  it('will not choose between several vaults', async () => {
    const fake = fakeServer({
      ...enrolment,
      'GET /v1/vaults': () => [vault('Notes'), { ...(vault('Work') as object), id: 'v2' }],
    })
    const run = await cli(
      ['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c', '--password', PASSWORD],
      { fetch: fake.fetch }
    )
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('--vault')
    expect(readConfig(dir)).toBeNull()
  })

  it('refuses to set up a vault that is already set up', async () => {
    await setUp()
    const fake = fakeServer(enrolment)
    const run = await cli(
      ['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c', '--password', PASSWORD],
      { fetch: fake.fetch }
    )
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('already set up')
    expect(fake.calls).toEqual([])
  })
})

describe('run', () => {
  it('syncs once and says what it did', async () => {
    await setUp()
    const fake = fakeServer(EMPTY_VAULT)
    const run = await cli(['run', '--dir', dir, '--once'], { fetch: fake.fetch })
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('sync: done')
    const log = await readFile(join(stateFolder(dir), 'log'), 'utf8')
    expect(log).toContain('sync: done')
  })

  it('refuses a directory that was never set up', async () => {
    const run = await cli(['run', '--dir', dir, '--once'])
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('init')
  })

  it('will not run beside another daemon on the same vault', async () => {
    await setUp()
    // This very process holds the lock, as a running daemon would.
    const release = await acquireLock(dir)
    try {
      const run = await cli(['run', '--dir', dir, '--once'])
      expect(run.code).toBe(3)
      expect(run.err.join('\n')).toContain(String(process.pid))
    } finally {
      release()
    }
  })

  it('reports a server it cannot reach and exits non-zero', async () => {
    await setUp()
    const unreachable: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'))
    const run = await cli(['run', '--dir', dir, '--once'], { fetch: unreachable })
    expect(run.code).toBe(1)
    expect(run.out).toEqual([])
    expect(run.err.join('\n')).toContain('never reached the server')
  })

  it('drops the lock when the vault will not open', async () => {
    await setUp()
    // A directory where the database goes: nothing can open that, and the failure comes after
    // the lock was taken.
    await mkdir(join(stateFolder(dir), 'state.db'))
    const run = await cli(['run', '--dir', dir, '--once'])
    expect(run.code).toBe(1)
    expect(run.err.join('\n')).toContain('state database')
    expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
  })

  it('walks the manifest again when the selective settings changed since the last sync', async () => {
    await setUp()
    const cfg = readConfig(dir)!
    writeConfig(dir, { ...cfg, selective: { ...cfg.selective, video: false } })
    const fake = fakeServer(SETTLED_VAULT)
    const walks = (): number =>
      fake.calls.filter((call) => call === 'GET /v1/vaults/v1/manifest').length
    const once = async (): Promise<void> => {
      const run = await cli(['run', '--dir', dir, '--once'], { fetch: fake.fetch })
      expect(run.err).toEqual([])
      expect(run.code).toBe(0)
    }

    // A first sync walks the manifest; the next, on the same settings, follows the feed alone.
    await once()
    expect(walks()).toBe(1)
    await once()
    expect(walks()).toBe(1)

    // Video switched on: the feed has moved past the clips this device passed over.
    writeConfig(dir, { ...cfg, selective: { ...cfg.selective, video: true } })
    await once()
    expect(walks()).toBe(2)
    const log = await readFile(join(stateFolder(dir), 'log'), 'utf8')
    expect(log).toContain('rescan: what this device syncs changed')
    // And once walked, not walked again.
    await once()
    expect(walks()).toBe(2)
  })

  it('walks the manifest again when the ignore file changed since the last sync', async () => {
    await setUp()
    const cfg = readConfig(dir)!
    await writeFile(ignoreFile(dir), '*.tmp\n')
    const fake = fakeServer(SETTLED_VAULT)
    const walks = (): number =>
      fake.calls.filter((call) => call === 'GET /v1/vaults/v1/manifest').length
    const once = async (): Promise<void> => {
      const run = await cli(['run', '--dir', dir, '--once'], { fetch: fake.fetch })
      expect(run.err).toEqual([])
      expect(run.code).toBe(0)
    }

    await once()
    await once()
    expect(walks()).toBe(1)
    // The pattern dropped: what it kept out of the feed is out there to fetch.
    await writeFile(ignoreFile(dir), '')
    await once()
    expect(walks()).toBe(2)
    // The file gone altogether is a different scope from an empty one; either way, once.
    await rm(ignoreFile(dir))
    await once()
    await once()
    expect(walks()).toBe(3)

    // The key itself: the ignore file's text is part of it, and so is its absence.
    expect(scopeKey(cfg.selective, '*.tmp\n')).not.toBe(scopeKey(cfg.selective, ''))
    expect(scopeKey(cfg.selective, '')).not.toBe(scopeKey(cfg.selective, null))
    expect(scopeKey(cfg.selective, null)).toBe(scopeKey({ ...cfg.selective }, null))
  })

  it('refuses an interval shorter than the floor', async () => {
    await setUp()
    const run = await cli(['run', '--dir', dir, '--once', '--interval', '1'])
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('at least 5')
  })

  it('refuses an interval that is not a number of seconds', async () => {
    await setUp()
    const run = await cli(['run', '--dir', dir, '--once', '--interval', 'often'])
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('--interval')
  })
})

describe('the daemon loop', () => {
  it('walks the manifest on start when the scope changed, and records it only once it got through', async () => {
    await setUp()
    // A device that synced to the head under some other scope.
    await withState(async (state) => {
      await state.setCursor(3)
      state.setMeta('scope', 'the scope of some earlier config')
    })
    let failWalks = 1
    const fake = fakeServer({
      ...SETTLED_VAULT,
      'GET /v1/vaults/v1/manifest': () =>
        failWalks-- > 0
          ? json({ error: { code: 'internal', message: 'not now' } }, 500)
          : { items: [], next: null, head_seq: 3 },
    })
    const walks = (): number =>
      fake.calls.filter((call) => call === 'GET /v1/vaults/v1/manifest').length
    const key = (): Promise<string | null> => withState(async (state) => state.getMeta('scope'))
    const session = async (done: (line: string) => boolean): Promise<Run> => {
      const started = launch(['run', '--dir', dir], { fetch: fake.fetch, WebSocket: DEAF })
      await until(started, () => started.out.some(done))
      process.kill(process.pid, 'SIGTERM')
      const run = await started.done
      expect(run.code).toBe(0)
      return run
    }

    // The rescan is the first run and its walk fails; the run `start` prompted follows it,
    // finds the cursor wound back and walks for itself. The key stays what it was.
    const first = await session((line) => line.startsWith('sync: done'))
    expect(first.out.join('\n')).toContain('sync: failed')
    expect(walks()).toBe(2)
    expect(await key()).toBe('the scope of some earlier config')

    // Next start: the scope still reads as changed, so the walk is made again — and recorded.
    await session((line) => line.startsWith('sync: done'))
    expect(walks()).toBe(3)
    expect(await key()).toBe(scopeKey(readConfig(dir)!.selective, null))

    // And a start on a recorded scope has only the feed to follow.
    await session((line) => line.startsWith('sync: done'))
    expect(walks()).toBe(3)
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`syncs until ${signal}, then lets go of everything`, async () => {
      await setUp()
      expect(process.listenerCount('SIGTERM')).toBe(0)
      expect(process.listenerCount('SIGINT')).toBe(0)

      const started = launch(['run', '--dir', dir], {
        fetch: fakeServer(EMPTY_VAULT).fetch,
        WebSocket: DEAF,
      })
      await until(started, () => started.out.some((line) => line.startsWith('state:')))
      expect(started.out[0]).toContain(`watching ${dir}`)
      expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(true)

      process.kill(process.pid, signal)
      const run = await started.done

      expect(run.code).toBe(0)
      expect(run.err).toEqual([])
      expect(run.out.join('\n')).toContain(`stopping on ${signal}`)
      // The lock is gone, and no handler of ours is left on the process either.
      expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
      expect(process.listenerCount('SIGTERM')).toBe(0)
      expect(process.listenerCount('SIGINT')).toBe(0)
      // What was printed was written down as well.
      const log = await readFile(join(stateFolder(dir), 'log'), 'utf8')
      expect(log).toContain('state:')
      expect(log).toContain(`stopping on ${signal}`)
    })
  }
})

describe('status', () => {
  it('prints the cursor, the head, what is pending, the last sync and the usage', async () => {
    await setUp()
    const fake = fakeServer({
      'GET /v1/vaults/v1/state': () => ({ head_seq: 7, settings: {}, usage: USAGE }),
      'GET /v1/vaults/v1/usage': () => ({ ...USAGE, top: [] }),
    })
    await writeFile(join(dir, 'fresh.md'), 'a note nobody has pushed yet')
    const run = await cli(['status', '--dir', dir], { fetch: fake.fetch })

    expect(run.code).toBe(0)
    const printed = run.out.join('\n')
    expect(printed).toContain('cursor     0')
    expect(printed).toContain('head_seq   7')
    expect(printed).toContain('pending    1')
    expect(printed).toContain('last sync  never')
    expect(printed).toContain('last error none')
    expect(printed).toContain('live 4.1 kB')
    expect(run.all).not.toContain(DEVICE_TOKEN)
  })
})

describe('status and the vault cap', () => {
  it('counts nothing as pending that the vault would not take', async () => {
    await setUp()
    const fake = fakeServer({
      'GET /v1/vaults/v1/state': () => ({
        head_seq: 0,
        settings: { max_file_bytes: 10 },
        usage: USAGE,
      }),
      'GET /v1/vaults/v1/usage': () => ({ ...USAGE, top: [] }),
    })
    await writeFile(join(dir, 'big.md'), 'well over ten bytes of note')
    await writeFile(join(dir, 'tiny.md'), 'ok')
    const run = await cli(['status', '--dir', dir], { fetch: fake.fetch })
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('pending    1')
  })
})

describe('history', () => {
  const versions = [
    {
      version_id: 'ver2',
      no: 2,
      seq: 2,
      op: 'modify',
      path: 'note.md',
      sha: 'b'.repeat(64),
      size: 20,
      mtime: 2000,
      actor: { kind: 'device', id: 'd1', name: 'laptop' },
      at: AT,
      merge: null,
    },
    {
      version_id: 'ver1',
      no: 1,
      seq: 1,
      op: 'create',
      path: 'note.md',
      sha: 'a'.repeat(64),
      size: 10,
      mtime: 1000,
      actor: { kind: 'device', id: 'd1', name: 'laptop' },
      at: AT,
      merge: null,
    },
  ]
  const found: Record<string, Handler> = {
    'GET /v1/vaults/v1/manifest': () => ({
      items: [
        {
          file_id: 'f1',
          path: 'note.md',
          kind: 'note',
          version_id: 'ver2',
          seq: 2,
          sha: 'b'.repeat(64),
          size: 20,
          mtime: 2000,
        },
      ],
      next: null,
      head_seq: 2,
    }),
    'GET /v1/vaults/v1/files/f1/versions': () => versions,
  }

  it('lists the versions, newest first', async () => {
    await setUp()
    const fake = fakeServer(found)
    const run = await cli(['history', '--dir', dir, 'note.md'], { fetch: fake.fetch })
    expect(run.code).toBe(0)
    expect(run.out[0]).toContain('ver2')
    expect(run.out[0]).toContain('#2')
    expect(run.out[0]).toContain('laptop')
    expect(run.out[1]).toContain('ver1')
  })

  it('diffs two versions of a note', async () => {
    await setUp()
    const fake = fakeServer({
      ...found,
      'GET /v1/vaults/v1/files/f1/versions/ver1': () => encodeText('one\ntwo\nthree\n'),
      'GET /v1/vaults/v1/files/f1/versions/ver2': () => encodeText('one\ntwo point five\nthree\n'),
    })
    const run = await cli(['history', '--dir', dir, 'note.md', '--diff', '1', '2'], {
      fetch: fake.fetch,
    })
    expect(run.code).toBe(0)
    const printed = run.out.join('\n')
    expect(printed).toContain('@@')
    expect(printed).toContain('-two')
    expect(printed).toContain('+two point five')
    expect(printed).toContain(' three')
  })

  it('says so rather than printing bytes when the versions are not text', async () => {
    await setUp()
    const fake = fakeServer({
      ...found,
      'GET /v1/vaults/v1/files/f1/versions/ver1': () => new Uint8Array([0, 1, 2]),
      'GET /v1/vaults/v1/files/f1/versions/ver2': () => new Uint8Array([0, 1, 2, 3]),
    })
    const run = await cli(['history', '--dir', dir, 'note.md', '--diff', 'ver1', 'ver2'], {
      fetch: fake.fetch,
    })
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('binary versions differ')
  })

  it('refuses a --diff that does not name two versions, before it asks anything', async () => {
    await setUp()
    const fake = fakeServer(found)
    const run = await cli(['history', '--dir', dir, 'note.md', '--diff', 'ver1'], {
      fetch: fake.fetch,
    })
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('two versions')
    expect(fake.calls).toEqual([])
  })

  it('refuses a version the file does not have', async () => {
    await setUp()
    const fake = fakeServer(found)
    const run = await cli(['history', '--dir', dir, 'note.md', '--diff', 'ver1', 'ver9'], {
      fetch: fake.fetch,
    })
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('ver9')
  })
})

describe('restore', () => {
  it('brings a deleted file back and syncs it onto the disk', async () => {
    await setUp()
    const bytes = encodeText('back again\n')
    const sha = await sha256(bytes)
    let restored = false
    const fake = fakeServer({
      'GET /v1/vaults/v1/trash': () => [
        {
          file_id: 'f1',
          path: 'gone.md',
          kind: 'note',
          deleted_at: AT,
          last_version_id: 'ver1',
          size: bytes.length,
        },
      ],
      'POST /v1/vaults/v1/trash/f1/restore': () => {
        restored = true
        return {
          status: 'applied',
          file_id: 'f1',
          version_id: 'ver2',
          seq: 2,
          path: 'gone.md',
          sha,
          size: bytes.length,
          mtime: 1000,
        }
      },
      'GET /v1/vaults/v1/state': () => ({ head_seq: 2, settings: {}, usage: USAGE }),
      'GET /v1/vaults/v1/manifest': () => ({
        items: restored
          ? [
              {
                file_id: 'f1',
                path: 'gone.md',
                kind: 'note',
                version_id: 'ver2',
                seq: 2,
                sha,
                size: bytes.length,
                mtime: 1000,
              },
            ]
          : [],
        next: null,
        head_seq: 2,
      }),
      'GET /v1/vaults/v1/changes': () => ({ items: [], head_seq: 2, next_since: 2 }),
      [`GET /v1/blobs/${sha}`]: () => bytes,
    })

    const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md'], { fetch: fake.fetch })
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('restored gone.md')
    expect(await readFile(join(dir, 'gone.md'), 'utf8')).toBe('back again\n')
  })

  it('says when nothing at that path was deleted', async () => {
    await setUp()
    const fake = fakeServer({ 'GET /v1/vaults/v1/trash': () => [] })
    const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md'], { fetch: fake.fetch })
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('gone.md')
  })

  it('will not restore a version and a deleted file at once', async () => {
    await setUp()
    const fake = fakeServer({ 'GET /v1/vaults/v1/trash': () => [] })
    const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md', '--version', 'ver1'], {
      fetch: fake.fetch,
    })
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('--deleted')
    expect(fake.calls).toEqual([])
  })

  it('drops the lock when the vault will not open', async () => {
    await setUp()
    await mkdir(join(stateFolder(dir), 'state.db'))
    const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md'])
    expect(run.code).toBe(1)
    expect(run.err.join('\n')).toContain('state database')
    expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
  })

  it('needs a path', async () => {
    await setUp()
    const run = await cli(['restore', '--dir', dir])
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('path')
  })
})

/** What a server says about a token it no longer takes. */
const REVOKED: Handler = () =>
  json({ error: { code: 'unauthorized', message: 'the device token was revoked' } }, 401)

const REVOKED_VAULT: Record<string, Handler> = {
  'GET /v1/vaults/v1/state': REVOKED,
  'GET /v1/vaults/v1/manifest': REVOKED,
  'GET /v1/vaults/v1/changes': REVOKED,
  'GET /v1/vaults/v1/usage': REVOKED,
}

const HINT = 'run `abele-sync init --force`'

describe('a token the server no longer takes', () => {
  it('ends run --once with the hint, non-zero', async () => {
    await setUp()
    const run = await cli(['run', '--dir', dir, '--once'], {
      fetch: fakeServer(REVOKED_VAULT).fetch,
    })
    expect(run.code).toBe(4)
    expect(run.err.join('\n')).toContain('revoked')
    expect(run.err.join('\n')).toContain(HINT)
    expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
  })

  it('ends the daemon with the hint, non-zero, and no handler left on the process', async () => {
    await setUp()
    const run = await cli(['run', '--dir', dir], {
      fetch: fakeServer(REVOKED_VAULT).fetch,
      WebSocket: DEAF,
    })
    expect(run.code).toBe(4)
    expect(run.out.join('\n')).toContain('stopping: ')
    expect(run.err.join('\n')).toContain(HINT)
    expect(process.listenerCount('SIGTERM')).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(0)
    expect(existsSync(join(stateFolder(dir), 'lock'))).toBe(false)
    // The engine's own line is in the log once, and the daemon did not write it a second time.
    const log = await readFile(join(stateFolder(dir), 'log'), 'utf8')
    expect(log.match(/failed: /g)).toHaveLength(1)
  })

  it('reports a revoked daemon locally without recontacting the server or printing its token', async () => {
    await setUp()
    const fake = fakeServer(REVOKED_VAULT)
    expect((await cli(['run', '--dir', dir, '--once'], { fetch: fake.fetch })).code).toBe(4)
    const calls = fake.calls.length
    const status = await cli(['status', '--dir', dir], { fetch: fake.fetch })
    expect(status.code).toBe(0)
    expect(status.out.join('\n')).toMatch(/state\s+revoked/)
    expect(fake.calls).toHaveLength(calls)
    expect(status.all).not.toContain(DEVICE_TOKEN)
  })

  it('does not inherit the revoked marker when enrolment replaces the personal credential', async () => {
    await setUp()
    expect(
      (await cli(['run', '--dir', dir, '--once'], { fetch: fakeServer(REVOKED_VAULT).fetch })).code
    ).toBe(4)
    writeConfig(dir, {
      ...readConfig(dir)!,
      deviceId: 'fresh-device',
      deviceToken: 'absd_fresh_credential',
    })
    const fake = fakeServer(EMPTY_VAULT)
    expect((await cli(['run', '--dir', dir, '--once'], { fetch: fake.fetch })).code).toBe(0)
    expect(fake.calls).toContain('GET /v1/vaults/v1/state')
  })

  it('has status say what to do', async () => {
    await setUp()
    const run = await cli(['status', '--dir', dir], { fetch: fakeServer(REVOKED_VAULT).fetch })
    expect(run.code).toBe(1)
    expect(run.err.join('\n')).toContain(HINT)
    expect(run.all).not.toContain(DEVICE_TOKEN)
  })
})

describe('init --force', () => {
  const again = (vaultId: string): Promise<Run> =>
    cli(
      [
        'init',
        '--force',
        '--server',
        'https://s',
        '--dir',
        dir,
        '--email',
        'a@b.c',
        '--password',
        PASSWORD,
      ],
      {
        fetch: fakeServer({
          ...enrolment,
          'POST /v1/devices': () => ({ device_id: 'd2', device_token: 'absd_the_second' }),
          'GET /v1/vaults': () => [{ ...(vault('Notes') as object), id: vaultId }],
        }).fetch,
      }
    )

  it('replaces the config and keeps the state when the vault is the same', async () => {
    await setUp()
    await withState(async (state) => state.setCursor(7))
    const run = await again('v1')
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('kept state.db')
    expect(readConfig(dir)).toMatchObject({ deviceId: 'd2', deviceToken: 'absd_the_second' })
    expect(await withState(async (state) => state.getCursor())).toBe(7)
    expect(run.all).not.toContain('absd_the_second')
  })

  it('removes the state when the vault is another', async () => {
    await setUp()
    await withState(async (state) => state.setCursor(7))
    const run = await again('v2')
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('removed state.db')
    expect(existsSync(stateDbFile(dir))).toBe(false)
    expect(readConfig(dir)).toMatchObject({ vaultId: 'v2', deviceId: 'd2' })
  })

  it("goes by the state's own word about its vault when the config cannot be read", async () => {
    await setUp()
    await withState(async (state) => {
      await state.setCursor(7)
      state.setMeta('vault', 'v1')
    })
    await writeFile(join(stateFolder(dir), 'config.json'), '{not json')
    const run = await again('v1')
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('kept state.db')
    expect(readConfig(dir)).toMatchObject({ vaultId: 'v1', deviceId: 'd2' })
  })

  it('removes a state that never said which vault it described', async () => {
    await setUp()
    await withState(async (state) => state.setCursor(7))
    await writeFile(join(stateFolder(dir), 'config.json'), '{not json')
    const run = await again('v1')
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain('removed state.db')
    expect(existsSync(stateDbFile(dir))).toBe(false)
  })
})

describe('the password prompt', () => {
  it('asks at a terminal, echoes nothing, and sends what was typed', async () => {
    let sent: unknown = null
    const fake = fakeServer({
      ...enrolment,
      'POST /v1/auth/login': ({ body }) => {
        sent = body
        return { account_token: 'abst_test', expires_at: AT }
      },
      'GET /v1/vaults': () => [vault('Notes')],
    })
    const stdin = Object.assign(new PassThrough(), { isTTY: true })
    const shown: string[] = []
    const stderr = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        shown.push(chunk.toString())
        done()
      },
    })
    stdin.end(`${PASSWORD}\n`)

    const run = await cli(['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c'], {
      fetch: fake.fetch,
      stdin,
      stderr,
    })

    expect(run.code).toBe(0)
    expect(sent).toMatchObject({ password: PASSWORD })
    expect(shown.join('')).toContain('password: ')
    expect(shown.join('')).not.toContain(PASSWORD)
    expect(run.all).not.toContain(PASSWORD)
  })

  it('does not ask when there is no terminal to ask at', async () => {
    const fake = fakeServer(enrolment)
    const stdin = Object.assign(new PassThrough(), { isTTY: false })
    const run = await cli(['init', '--server', 'https://s', '--dir', dir, '--email', 'a@b.c'], {
      fetch: fake.fetch,
      stdin,
      stderr: new PassThrough(),
    })
    expect(run.code).toBe(2)
    expect(run.err.join('\n')).toContain('ABELE_PASSWORD')
    expect(fake.calls).toEqual([])
  })
})

describe('the temp folder', () => {
  const leftover = (): string => join(stateFolder(dir), 'tmp', 'half-written')

  it('is left alone by status and history, which take no lock', async () => {
    await setUp()
    await mkdir(join(stateFolder(dir), 'tmp'), { recursive: true })
    await writeFile(leftover(), 'the daemon may be writing this')
    const fake = fakeServer({
      'GET /v1/vaults/v1/state': () => ({ head_seq: 0, settings: {}, usage: USAGE }),
      'GET /v1/vaults/v1/usage': () => ({ ...USAGE, top: [] }),
      'GET /v1/vaults/v1/manifest': () => ({ items: [], next: null, head_seq: 0 }),
      'GET /v1/vaults/v1/trash': () => [],
    })
    expect((await cli(['status', '--dir', dir], { fetch: fake.fetch })).code).toBe(0)
    expect(existsSync(leftover())).toBe(true)
    const history = await cli(['history', '--dir', dir, 'nowhere.md'], { fetch: fake.fetch })
    expect(history.code).toBe(2)
    expect(existsSync(leftover())).toBe(true)
  })

  it('is swept by run once it holds the lock, and gone when it exits', async () => {
    await setUp()
    await mkdir(join(stateFolder(dir), 'tmp'), { recursive: true })
    await writeFile(leftover(), 'what a killed daemon left')
    const run = await cli(['run', '--dir', dir, '--once'], { fetch: fakeServer(EMPTY_VAULT).fetch })
    expect(run.code).toBe(0)
    expect(existsSync(leftover())).toBe(false)
    expect(existsSync(join(stateFolder(dir), 'tmp'))).toBe(false)
  })
})

describe('the summary', () => {
  it('is printed by the daemon after every sync, and read back by status with the refusals', async () => {
    await setUp()
    const note = 'thirty bytes of note, or so..'
    await writeFile(join(dir, 'big.md'), note)
    const fake = fakeServer({
      ...EMPTY_VAULT,
      // The vault has the bytes already, so nothing is uploaded; the commit refuses the op.
      [`HEAD /v1/blobs/${await sha256(encodeText(note))}`]: () => ({}),
      'POST /v1/vaults/v1/commit': () => ({
        head_seq: 0,
        results: [
          {
            status: 'rejected',
            code: 'too_large',
            message: 'the file is 30 bytes; the limit is 10',
          },
        ],
      }),
      'GET /v1/vaults/v1/usage': () => ({ ...USAGE, top: [] }),
    })
    const started = launch(['run', '--dir', dir], { fetch: fake.fetch, WebSocket: DEAF })
    await until(started, () => started.out.some((line) => line.startsWith('sync: done (pulled')))
    process.kill(process.pid, 'SIGTERM')
    const run = await started.done
    expect(run.code).toBe(0)
    const summary = run.out.find((line) => line.startsWith('sync: done (pulled'))!
    expect(summary).toContain('rejected 1')
    const log = await readFile(join(stateFolder(dir), 'log'), 'utf8')
    expect(log).toContain(summary)
    expect(log).toContain('push: create refused: too_large the file is 30 bytes')

    const status = await cli(['status', '--dir', dir], { fetch: fake.fetch })
    expect(status.code).toBe(0)
    const printed = status.out.join('\n')
    expect(printed).toContain(`summary    ${summary}`)
    expect(printed).toContain('refused    push: create refused: too_large the file is 30 bytes')
  })
})

describe('restore beside a running daemon', () => {
  let held: (() => void) | null = null
  afterEach(() => {
    held?.()
    held = null
  })

  it('restores on the server, touches nothing on the disk, and exits clean', async () => {
    await setUp()
    // This very process holds the lock, as a running daemon would; the test's end lets it go.
    held = await acquireLock(dir)
    let restored = false
    const fake = fakeServer({
      'GET /v1/vaults/v1/trash': () => [
        {
          file_id: 'f1',
          path: 'gone.md',
          kind: 'note',
          deleted_at: AT,
          last_version_id: 'ver1',
          size: 4,
        },
      ],
      'POST /v1/vaults/v1/trash/f1/restore': () => {
        restored = true
        return {
          status: 'applied',
          file_id: 'f1',
          version_id: 'ver2',
          seq: 2,
          path: 'gone.md',
          sha: 'a'.repeat(64),
          size: 4,
          mtime: 1000,
        }
      },
    })
    const run = await cli(['restore', '--dir', dir, '--deleted', 'gone.md'], { fetch: fake.fetch })
    expect(run.err).toEqual([])
    expect(run.code).toBe(0)
    expect(run.out.join('\n')).toContain(
      'restored gone.md on the server; the daemon will bring it down'
    )
    expect(restored).toBe(true)
    expect(existsSync(join(dir, 'gone.md'))).toBe(false)
    // The daemon's lock is still the daemon's.
    const lock = join(stateFolder(dir), 'lock')
    expect((await readFile(lock, 'utf8')).split('\n')[0]).toBe(String(process.pid))
    await expect(acquireLock(dir)).rejects.toThrow(/another abele-sync is running/)
    // Nothing was synced: no state, no pull.
    expect(fake.calls.some((call) => call.includes('/changes') || call.includes('/manifest'))).toBe(
      false
    )
  })
})

describe('what a server says', () => {
  it('is printed as one plain line, whatever it tried to draw', async () => {
    await setUp()
    const fake = fakeServer({
      'GET /v1/vaults/v1/state': () =>
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
    const run = await cli(['status', '--dir', dir], { fetch: fake.fetch })
    expect(run.code).toBe(1)
    // The escape byte is gone and the text it was meant to colour stays, as text.
    expect(run.err).toEqual(['one[31m line sync: done (pulled 9) and no more'])
  })
})
