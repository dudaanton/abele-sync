import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeAccessToken } from '@abele/sync-protocol'
import { runAdmin } from '../../src/admin-cli/index.js'
import { createDb } from '../../src/db/connect.js'
let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})
it('001 local user create prints a root token usable without account/device registration', async () => {
  await mkdir(resolve('.scratch'), { recursive: true })
  dir = await mkdtemp(join(resolve('.scratch'), 'v2-admin-'))
  const env = {
    ABELE_DATABASE_URL: `sqlite://${join(dir, 'server.db')}`,
    ABELE_BLOB_DIR: join(dir, 'blobs'),
    ABELE_MASTER_KEY: 'ab'.repeat(32),
    ABELE_TOKEN_PEPPER: 'synthetic-admin',
  }
  const lines: string[] = [],
    errors: string[] = []
  expect(
    await runAdmin(
      ['user', 'create', '--label', 'Owner', '--address', 'https://SYNC.example/'],
      env,
      { log: (s) => lines.push(s), error: (s) => errors.push(s) }
    )
  ).toBe(0)
  expect(errors).toEqual([])
  expect(lines).toHaveLength(1)
  const token = decodeAccessToken(lines[0]!)
  if (token.v !== 1) throw new Error('root provisioning must retain the legacy payload')
  expect(token.address).toBe('https://sync.example')
  expect(token.scope.path).toBe('/')
  const db = createDb(env.ABELE_DATABASE_URL)
  try {
    expect(await db.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
    expect(await db.db.selectFrom('spaces').selectAll().execute()).toHaveLength(1)
    const tables = (await db.db.introspection.getTables()).map((table) => table.name)
    expect(tables).not.toContain('accounts')
    expect(tables).not.toContain('devices')
    expect(await db.db.selectFrom('access_tokens').selectAll().execute()).toHaveLength(1)
    expect(
      JSON.stringify(await db.db.selectFrom('access_tokens').selectAll().execute())
    ).not.toContain(token.key)
  } finally {
    await db.close()
  }
  const refused: string[] = []
  expect(
    await runAdmin(
      ['user', 'create', '--label', 'Bad', '--address', 'http://insecure.example'],
      env,
      { log: (s) => refused.push(s), error: (s) => errors.push(s) }
    )
  ).toBe(1)
  expect(refused).toEqual([])
  const reopened = createDb(env.ABELE_DATABASE_URL)
  try {
    expect(await reopened.db.selectFrom('users').selectAll().execute()).toHaveLength(1)
  } finally {
    await reopened.close()
  }
})
