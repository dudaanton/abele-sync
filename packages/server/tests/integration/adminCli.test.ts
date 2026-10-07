import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Kysely } from 'kysely'
import { runAdmin, type AdminOutput } from '../../src/admin-cli/index.js'
import { login } from '../../src/auth/accounts.js'
import { BlobStore } from '../../src/blobs/store.js'
import { createDb } from '../../src/db/connect.js'
import type { Database } from '../../src/db/schema.js'

/**
 * The admin CLI against a database on disk: it opens its own connection from
 * the environment, so a test that wants to see what a command did has to open
 * the same file afterwards. Nothing here writes to the console — `out` is a
 * pair of arrays, which is also how the tests read what was printed.
 */

const MASTER_KEY = 'ab'.repeat(32)
const PEPPER = 'test'
const PASSWORD = 'correct horse battery staple'

let dir: string
let env: NodeJS.ProcessEnv

const capture = () => {
  const logged: string[] = []
  const errors: string[] = []
  return {
    logged,
    errors,
    out: {
      log: (s: string): void => void logged.push(s),
      error: (s: string): void => void errors.push(s),
    },
  }
}

/** One invocation with the shared environment; the tests read `out` afterwards. */
const run = (out: AdminOutput, ...args: string[]): Promise<number> => runAdmin(args, env, out)

const withDb = async <T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> => {
  const handle = createDb(env.ABELE_DATABASE_URL as string)
  try {
    return await fn(handle.db)
  } finally {
    await handle.close()
  }
}

const authDeps = (db: Kysely<Database>) => ({ db, pepper: PEPPER, accountTokenTtlMs: 3_600_000 })

/** How many files a directory holds, all the way down. */
async function fileCount(path: string): Promise<number> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true })
  return entries.filter((entry) => entry.isFile()).length
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-admin-'))
  env = {
    ABELE_DATABASE_URL: `sqlite://${join(dir, 'abele.db')}`,
    ABELE_BLOB_DIR: join(dir, 'blobs'),
    ABELE_MASTER_KEY: MASTER_KEY,
    ABELE_TOKEN_PEPPER: PEPPER,
  }
  await mkdir(join(dir, 'blobs'), { recursive: true })
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('admin cli', () => {
  it('creates an account the server can then log in', async () => {
    const { out, logged, errors } = capture()

    const code = await run(out, 'create-account', '--email', 'A@x.io', '--password', PASSWORD)

    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(logged.join('\n')).toContain('a@x.io')
    // Neither the password nor anything derived from it may reach the output.
    expect(logged.join('\n')).not.toContain(PASSWORD)
    expect(logged.join('\n')).not.toContain('scrypt$')

    const session = await withDb((db) => login(authDeps(db), 'a@x.io', PASSWORD))
    expect(session.account_token).toMatch(/^abst_/)
  })

  it('refuses an email that already has an account', async () => {
    const { out, logged, errors } = capture()

    const code = await run(out, 'create-account', '--email', 'a@x.io', '--password', PASSWORD)

    expect(code).toBe(1)
    expect(logged).toEqual([])
    expect(errors.join('\n')).toMatch(/already/i)
  })

  it('resets a password, and the old one stops working', async () => {
    const { out, errors } = capture()

    const code = await run(out, 'reset-password', '--email', 'a@x.io', '--password', 'a new one')

    expect(code).toBe(0)
    expect(errors).toEqual([])
    await expect(withDb((db) => login(authDeps(db), 'a@x.io', 'a new one'))).resolves.toBeDefined()
    await expect(withDb((db) => login(authDeps(db), 'a@x.io', PASSWORD))).rejects.toThrow()
  })

  it('reports an email no account has', async () => {
    const { out, logged, errors } = capture()

    const code = await run(out, 'reset-password', '--email', 'nobody@x.io', '--password', 'pw')

    expect(code).toBe(1)
    expect(logged).toEqual([])
    expect(errors.join('\n')).toContain('nobody@x.io')
  })

  it('creates a vault and lists it with its owner', async () => {
    const created = capture()
    const owner = ['--owner-email', 'a@x.io', '--name', 'Notes']
    expect(await run(created.out, 'create-vault', ...owner)).toBe(0)

    const listed = capture()
    expect(await run(listed.out, 'list-vaults')).toBe(0)

    const vaults = await withDb((db) => db.selectFrom('vaults').select(['id', 'name']).execute())
    expect(vaults).toHaveLength(1)
    const line = listed.logged.join('\n')
    expect(line).toContain(vaults[0]!.id)
    expect(line).toContain('Notes')
    expect(line).toContain('a@x.io')
    expect(listed.errors).toEqual([])
  })

  it('refuses to create a vault for an owner who does not exist', async () => {
    const { out, errors } = capture()

    const code = await run(out, 'create-vault', '--owner-email', 'nobody@x.io', '--name', 'Notes')

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('nobody@x.io')
  })

  it('runs retention once and prints what it collected', async () => {
    // An upload from three days ago: proof the command ran the sweep, not a stub.
    await withDb((db) =>
      db
        .insertInto('uploads')
        .values({
          id: 'stale-upload',
          sha: 'ab'.repeat(32),
          size: 10,
          part_size: 10,
          parts_received: '[]',
          created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        })
        .execute()
    )
    const { out, logged, errors } = capture()

    const code = await run(out, 'gc')

    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(logged.join('\n')).toContain('versions removed: 0')
    expect(logged.join('\n')).toContain('blobs removed: 0')
    expect(logged.join('\n')).toContain('uploads swept: 1')
    const left = await withDb((db) => db.selectFrom('uploads').select('id').execute())
    expect(left).toEqual([])
  })

  it('backs the database and the blobs up, leaving the half-sent parts behind', async () => {
    const store = new BlobStore(join(dir, 'blobs'), Buffer.from(MASTER_KEY, 'hex'))
    await store.put(Buffer.from('one'))
    await store.put(Buffer.from('two'))
    // An upload in progress: parts, not blobs, and no business in a backup.
    await mkdir(join(dir, 'blobs', 'uploads', 'half-sent'), { recursive: true })
    await writeFile(join(dir, 'blobs', 'uploads', 'half-sent', '0'), 'part')
    const to = join(dir, 'backup')
    const { out, logged, errors } = capture()

    const code = await run(out, 'backup', '--to', to)

    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(await exists(join(to, 'abele.db'))).toBe(true)
    expect(await fileCount(join(to, 'blobs'))).toBe(2)
    expect(await fileCount(join(dir, 'blobs'))).toBe(3)
    expect(await exists(join(to, 'blobs', 'uploads'))).toBe(false)
    expect(logged.join('\n')).toContain(join(to, 'abele.db'))

    const again = capture()
    expect(await run(again.out, 'backup', '--to', to)).toBe(1)
    expect(again.errors.join('\n')).toContain('already exists')
  })

  it('refuses a backup directory that already holds blobs', async () => {
    const to = join(dir, 'blobs-there')
    await mkdir(join(to, 'blobs'), { recursive: true })
    const { out, errors } = capture()

    expect(await run(out, 'backup', '--to', to)).toBe(1)
    expect(errors.join('\n')).toContain(join(to, 'blobs'))
    expect(errors.join('\n')).toContain('already exists')
    // Nothing was written beside it: the check comes before the database is dumped.
    expect(await exists(join(to, 'abele.db'))).toBe(false)
  })

  it('answers a command it does not know, and a missing option, with 1', async () => {
    const unknown = capture()
    expect(await run(unknown.out, 'do-something')).toBe(1)
    expect(unknown.errors.join('\n')).toContain('do-something')
    expect(unknown.logged).toEqual([])

    const missing = capture()
    expect(await run(missing.out, 'create-account', '--email', 'b@x.io')).toBe(1)
    expect(missing.errors.join('\n')).toContain('--password')
  })

  it('says what is missing when the environment is not a server', async () => {
    const { out, errors } = capture()

    const bare = { ABELE_DATABASE_URL: env.ABELE_DATABASE_URL }
    const code = await runAdmin(['list-vaults'], bare, out)

    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('ABELE_MASTER_KEY')
  })

  it('prints its commands when asked for help', async () => {
    const { out, logged } = capture()

    const code = await run(out, '--help')

    expect(code).toBe(0)
    const help = logged.join('\n')
    const commands = ['create-account', 'reset-password', 'create-vault', 'list-vaults', 'gc']
    for (const command of [...commands, 'backup']) {
      expect(help).toContain(command)
    }
  })
})
