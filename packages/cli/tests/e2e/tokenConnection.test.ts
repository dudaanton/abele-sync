import { afterEach, describe, expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { sql } from 'kysely'
import { join, resolve } from 'node:path'
import { v2Server, type V2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { AccessClient } from '@abele/sync-core'
import { runCli } from '../../src/cli.js'
import { readConfig } from '../../src/config.js'

let server: V2Server | undefined
let scratch: string | undefined
const invoke = async (args: string[], env: NodeJS.ProcessEnv = {}, fetchImpl = fetch) => {
  const out: string[] = [],
    err: string[] = []
  const code = await runCli(args, env, {
    fetch: fetchImpl,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
async function fixture() {
  server = await v2Server()
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper, dialect: 'sqlite' },
    'CLI fixture',
    server.address
  )
  await mkdir(resolve('.scratch'), { recursive: true })
  scratch = await mkdtemp(join(resolve('.scratch'), 'cli-token-'))
  const a = join(scratch, 'A'),
    b = join(scratch, 'B')
  await mkdir(a)
  await mkdir(b)
  const owner = AccessClient.fromToken(root.token, { fetch })
  const sibling = await owner.issue({
    scope: { kind: 'folder', id: root.info.scope.id },
    label: 'B',
  })
  return { root, a, b, owner, sibling }
}
afterEach(async () => {
  await server?.close()
  server = undefined
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

describe('production CLI token connections over real HTTP', () => {
  it('H05 bounded CLI runs recover server rollback from retained local bytes', async () => {
    const { root, a, b, sibling } = await fixture()
    for (const [dir, token] of [
      [a, root.token],
      [b, sibling.token],
    ] as const) {
      const connected = await invoke(['connect', '--dir', dir, '--token', token])
      expect(connected.code, connected.err).toBe(0)
    }
    await writeFile(join(a, 'Keep.md'), 'keep')
    for (const dir of [a, b]) expect((await invoke(['run', '--dir', dir, '--once'])).code).toBe(0)
    const backup = join(scratch!, 'backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server!.db)
    await writeFile(join(a, 'Lost.md'), 'new local bytes')
    for (const dir of [a, b]) expect((await invoke(['run', '--dir', dir, '--once'])).code).toBe(0)
    await server!.restart(async () => {
      await cp(backup, join(server!.dir, 'server.db'))
    })
    for (const dir of [a, b, a, b]) {
      const result = await invoke(['run', '--dir', dir, '--once'])
      expect(result.code, result.err).toBe(0)
    }
    for (const dir of [a, b]) {
      expect(await readFile(join(dir, 'Keep.md'), 'utf8')).toBe('keep')
      expect(await readFile(join(dir, 'Lost.md'), 'utf8')).toBe('new local bytes')
    }
    expect(
      await server!.db.selectFrom('files').select('id').where('path', '=', 'Lost.md').execute()
    ).toHaveLength(1)
    expect(
      await server!.db.selectFrom('versions').select('id').where('op', '=', 'delete').execute()
    ).toEqual([])
  })
  it('connects, persists, restarts bounded runs, and disconnects without revoking or deleting bytes', async () => {
    const { root, a, b, owner, sibling } = await fixture()
    expect((await invoke(['connect', '--dir', a], { ABELE_TOKEN: root.token })).code).toBe(0)
    expect((await invoke(['connect', '--dir', b, '--token', sibling.token])).code).toBe(0)
    await mkdir(join(a, 'Empty'))
    await writeFile(join(a, 'Note.md'), 'one\ntwo\n')
    for (const dir of [a, b, a, b]) {
      const result = await invoke(['run', '--dir', dir, '--once'])
      expect(result.code, result.err).toBe(0)
    }
    expect(await readFile(join(b, 'Note.md'), 'utf8')).toBe('one\ntwo\n')
    const status = await invoke(['status', '--dir', b])
    expect(status.code, status.err).toBe(0)
    expect(status.out).toContain('pending    0')
    expect(status.out).toContain('scope      folder /')
    expect(status.out + status.err).not.toContain(sibling.token)
    expect((await invoke(['disconnect', '--dir', b])).code).toBe(0)
    expect(readConfig(b)).toBeNull()
    expect(await readFile(join(b, 'Note.md'), 'utf8')).toBe('one\ntwo\n')
    expect(
      (await owner.tokens()).items.some((t) => t.id === sibling.info.id && !t.revoked_at)
    ).toBe(true)
    expect((await invoke(['connect', '--dir', b, '--token', root.token])).code).not.toBe(0)
    expect(readConfig(b)).toBeNull()
    expect(await readFile(join(b, 'Note.md'), 'utf8')).toBe('one\ntwo\n')
    expect((await invoke(['connect', '--dir', b, '--token', sibling.token])).code).toBe(0)
    expect((await invoke(['run', '--dir', b, '--once'])).code).toBe(0)
  })
  it('keeps an existing connection on malformed, unavailable and replacement attempts; revocation preserves files', async () => {
    const { root, a, owner, sibling } = await fixture()
    expect((await invoke(['connect', '--dir', a, '--token', sibling.token])).code).toBe(0)
    await writeFile(join(a, 'local.md'), 'unsent work')
    expect((await invoke(['connect', '--dir', a, '--token', 'damaged'])).code).not.toBe(0)
    expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).not.toBe(0)
    expect(readConfig(a)?.deviceToken).toBe(sibling.token)
    const offline = await invoke(['run', '--dir', a, '--once'], {}, async () => {
      throw new Error('offline')
    })
    expect(offline.code).not.toBe(0)
    await owner.revoke(sibling.info.id)
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(4)
    expect(await readFile(join(a, 'local.md'), 'utf8')).toBe('unsent work')
  })
})
