import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Kysely } from 'kysely'
import { runAdmin, type AdminOutput } from '../../src/admin-cli/index.js'
import { BlobStore } from '../../src/blobs/store.js'
import { createDb } from '../../src/db/connect.js'
import type { Database } from '../../src/db/schema.js'

const MASTER_KEY = 'ab'.repeat(32)
let dir: string
let env: NodeJS.ProcessEnv
const capture = () => {
  const logged: string[] = [],
    errors: string[] = []
  return {
    logged,
    errors,
    out: {
      log: (s: string): void => void logged.push(s),
      error: (s: string): void => void errors.push(s),
    },
  }
}
const run = (out: AdminOutput, ...args: string[]) => runAdmin(args, env, out)
const withDb = async <T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> => {
  const handle = createDb(env.ABELE_DATABASE_URL as string)
  try {
    return await fn(handle.db)
  } finally {
    await handle.close()
  }
}
async function fileCount(path: string): Promise<number> {
  return (await readdir(path, { recursive: true, withFileTypes: true })).filter((entry) =>
    entry.isFile()
  ).length
}
const exists = (path: string) =>
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
    ABELE_TOKEN_PEPPER: 'synthetic',
  }
  await mkdir(join(dir, 'blobs'), { recursive: true })
  expect(
    await run(
      capture().out,
      'user',
      'create',
      '--label',
      'Synthetic',
      '--address',
      'https://sync.example'
    )
  ).toBe(0)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('admin storage commands (independent regressions retained)', () => {
  it('runs retention once and prints what it collected', async () => {
    // Keep this engine/ops regression strong. GC must be rewired to token spaces; it is not silently dropped.
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
          vault_id: null,
          device_id: null,
          completing_at: null,
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
    expect(await withDb((db) => db.selectFrom('uploads').select('id').execute())).toEqual([])
  })
  it('backs the database and the blobs up, leaving the half-sent parts behind', async () => {
    const store = new BlobStore(join(dir, 'blobs'), Buffer.from(MASTER_KEY, 'hex'))
    await store.put(Buffer.from('one'))
    await store.put(Buffer.from('two'))
    await mkdir(join(dir, 'blobs', 'uploads', 'half-sent'), { recursive: true })
    await writeFile(join(dir, 'blobs', 'uploads', 'half-sent', '0'), 'part')
    const to = join(dir, 'backup')
    const { out, logged, errors } = capture()
    expect(await run(out, 'backup', '--to', to)).toBe(0)
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
    expect(await exists(join(to, 'abele.db'))).toBe(false)
  })
  it('answers an unknown command and a missing option with 1', async () => {
    const unknown = capture()
    expect(await run(unknown.out, 'do-something')).toBe(1)
    expect(unknown.errors.join('\n')).toContain('do-something')
    expect(unknown.logged).toEqual([])
    const missing = capture()
    expect(await run(missing.out, 'user', 'create', '--label', 'B')).toBe(1)
    expect(missing.errors.join('\n')).toContain('--address')
  })
  it('says what is missing when the environment is not a server', async () => {
    const { out, errors } = capture()
    expect(
      await runAdmin(
        ['user', 'create', '--label', 'B', '--address', 'https://sync.example'],
        { ABELE_DATABASE_URL: env.ABELE_DATABASE_URL },
        out
      )
    ).toBe(1)
    expect(errors.join('\n')).toContain('ABELE_MASTER_KEY')
  })
  it('prints the token provisioning and backup commands, not removed account commands', async () => {
    const { out, logged } = capture()
    expect(await run(out, '--help')).toBe(0)
    for (const command of ['user', 'backup']) expect(logged.join('\n')).toContain(command)
    for (const command of ['create-account', 'reset-password', 'create-vault', 'list-vaults'])
      expect(logged.join('\n')).not.toContain(command)
  })
})
