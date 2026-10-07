import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

/**
 * A real abele server, in a process of its own, for the daemon to talk to.
 *
 * Not `app.inject` and not a fake: the point of these tests is the daemon as it is shipped —
 * its own `fetch` over a socket, its own JSON, its own error handling — so the server is
 * built once if it has not been, started on a free port with a database and a blob directory
 * of its own, and torn down with everything it wrote.
 *
 * `kill` is safe to call twice and must be called even when a test fails, which is what the
 * `afterAll` in every suite here is for.
 */

export interface SpawnedServer {
  /** Where the server listens: `http://127.0.0.1:<port>`. */
  url: string
  /** Test fixture for a record written by an older server release. */
  databasePath: string
  /** Makes an account the way an operator would, through the admin CLI. */
  createAccount(email: string, password: string): Promise<void>
  kill(): Promise<void>
}

/** The repository root: five levels up from `packages/cli/tests/e2e/helpers`. */
const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const SERVER = join(ROOT, 'packages/server/dist/index.js')
const ADMIN = join(ROOT, 'packages/server/dist/admin-cli/index.js')
/** How long the server has to answer `/healthz` before the suite gives up on it. */
const READY_MS = 30_000
/** How long a build may take when `dist` is not there yet. */
const BUILD_MS = 10 * 60_000

export async function spawnServer(): Promise<SpawnedServer> {
  build()
  const dir = await mkdtemp(join(tmpdir(), 'abele-server-'))
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ABELE_DATABASE_URL: `sqlite://${join(dir, 'abele.db')}`,
    ABELE_BLOB_DIR: join(dir, 'blobs'),
    ABELE_MASTER_KEY: randomBytes(32).toString('hex'),
    ABELE_TOKEN_PEPPER: randomBytes(16).toString('hex'),
    ABELE_PORT: String(port),
    ABELE_HOST: '127.0.0.1',
  }

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  // Held rather than printed: a suite that passes says nothing, and one that does not gets
  // the server's own words in the failure.
  const said: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => said.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => said.push(chunk.toString()))

  const url = `http://127.0.0.1:${port}`
  let killed = false
  const kill = async (): Promise<void> => {
    if (!killed) {
      killed = true
      child.kill('SIGTERM')
      await ended(child)
    }
    await rm(dir, { recursive: true, force: true })
  }

  try {
    await ready(url, child, said)
  } catch (error) {
    await kill()
    throw error
  }

  return {
    url,
    databasePath: join(dir, 'abele.db'),
    kill,
    async createAccount(email: string, password: string): Promise<void> {
      const done = spawnSync(
        process.execPath,
        [ADMIN, 'create-account', '--email', email, '--password', password],
        { env, encoding: 'utf8' }
      )
      if (done.status !== 0) {
        throw new Error(`create-account failed: ${done.stderr || done.stdout}`)
      }
    },
  }
}

/**
 * The server as it ships. Built once, and only when it is not there already.
 *
 * The plain build first, because that is what a developer runs and it is incremental. If it
 * leaves nothing behind, it is built again with `--force`: `tsc -b` decides what to build from
 * its `tsbuildinfo` rather than from what is on disk, so a `dist` that was deleted while the
 * build info stayed would otherwise be declared up to date and never written again.
 */
function build(): void {
  if (existsSync(SERVER) && existsSync(ADMIN)) return
  npmBuild([])
  if (existsSync(SERVER) && existsSync(ADMIN)) return
  npmBuild(['--', '--force'])
  if (!existsSync(SERVER) || !existsSync(ADMIN)) {
    throw new Error(`the build left no ${SERVER}`)
  }
}

function npmBuild(extra: string[]): void {
  const done = spawnSync('npm', ['run', 'build', ...extra], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: BUILD_MS,
  })
  if (done.status !== 0) throw new Error(`npm run build failed: ${done.stderr || done.stdout}`)
}

/** Waits for `/healthz`, or for the server to die trying. */
async function ready(url: string, child: ChildProcess, said: string[]): Promise<void> {
  const deadline = Date.now() + READY_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the server exited with ${child.exitCode}: ${said.join('')}`)
    }
    try {
      const response = await fetch(`${url}/healthz`)
      if (response.ok) return
    } catch {
      /* not listening yet */
    }
    await delay(100)
  }
  throw new Error(`the server never answered ${url}/healthz: ${said.join('')}`)
}

/** A port nothing is on, by taking one and letting it go again. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => (port === 0 ? reject(new Error('no free port')) : resolve(port)))
    })
  })
}

/**
 * Waits for the process to actually be gone. A server that will not stop on SIGTERM is killed
 * after five seconds, and then waited for again: returning while it still holds the port would
 * leave the next suite racing it.
 */
async function ended(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try {
    await exited
  } finally {
    clearTimeout(force)
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
