import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acquireLock } from '../../src/lock.js'
import {
  cleanupFolders,
  cli,
  config,
  folder,
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
  ;({ a, b } = await vaultPair(server, 'Plugin confirmation'))
}, SETUP_MS)
afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

async function listed(id: string, dir = b): Promise<string> {
  const run = await cli(['code', '--dir', dir])
  expect(run.code, run.all).toBe(0)
  const line = run.out.find((one) => one.startsWith(`plugin ${id} `))
  expect(line, run.all).toBeDefined()
  const fingerprint = /expect ([a-f0-9]+)/.exec(line ?? '')?.[1]
  expect(fingerprint).toBeDefined()
  return fingerprint!
}
async function decide(id: string, action: '--approve' | '--reject' = '--approve', dir = b) {
  return cli(['code', '--dir', dir, action, id, '--expect', await listed(id, dir)])
}

const remoteHead = async (path: string) => {
  const item = (await clientFor(a).manifest(null)).items.find((one) => one.path === path)
  expect(item).toBeDefined()
  return item!
}

describe('daemon plugin code approval', () => {
  it('stages new code across run --once restarts, while settings and plugin data still sync', async () => {
    for (const [file, text] of Object.entries({
      'main.js': 'sample()',
      'styles.css': 'body {}',
      'manifest.json': '{"id":"sample","version":"1.0.0"}',
      'data.json': '{"enabled":true}',
    })) {
      await write(a, code('sample', file), text)
    }
    await write(a, '.obsidian/community-plugins.json', '["sample"]')
    await syncOnce(a)
    const summary = await syncOnce(b)
    expect(existsSync(join(b, code('sample')))).toBe(false)
    expect(existsSync(join(b, code('sample', 'manifest.json')))).toBe(false)
    expect(existsSync(join(b, code('sample', 'styles.css')))).toBe(false)
    expect(await read(b, code('sample', 'data.json'))).toBe('{"enabled":true}')
    expect(await read(b, '.obsidian/community-plugins.json')).toBe('["sample"]')
    expect(summary).toContain('code awaiting approval')
    await syncOnce(b)
    expect(existsSync(join(b, code('sample')))).toBe(false)
    const status = await cli(['status', '--dir', b])
    expect(status.code, status.all).toBe(0)
    expect(status.all).toContain('code awaiting approval')
    expect(status.all).toContain('sample')
    const approved = await decide('sample')
    expect(approved.code, approved.all).toBe(0)
    expect(await read(b, code('sample'))).toBe('sample()')
    expect(await read(b, code('sample', 'manifest.json'))).toContain('1.0.0')
    await syncOnce(b)
    expect((await cli(['code', '--dir', b])).all).toContain('no plugin code awaiting approval')
  })

  it('rejects an existing plugin update and a new plugin without installing either', async () => {
    await write(a, code('sample'), 'changedSample()')
    await write(a, code('declined'), 'declined()')
    await syncOnce(a)
    await syncOnce(b)
    expect(await read(b, code('sample'))).toBe('sample()')
    expect(existsSync(join(b, code('declined')))).toBe(false)
    expect((await decide('sample', '--reject')).code).toBe(0)
    expect((await decide('declined', '--reject')).code).toBe(0)
    await syncOnce(b)
    expect(await read(b, code('sample'))).toBe('sample()')
    expect(existsSync(join(b, code('declined')))).toBe(false)
    expect(await remoteHead(code('declined'))).toMatchObject({ path: code('declined') })
  })

  it('refuses a stale fingerprint and never approves another plugin implicitly', async () => {
    await write(a, code('first'), 'firstV1()')
    await write(a, code('second'), 'second()')
    await syncOnce(a)
    await syncOnce(b)
    const old = await listed('first')
    await write(a, code('first'), 'firstV2()')
    await syncOnce(a)
    await syncOnce(b)
    const stale = await cli(['code', '--dir', b, '--approve', 'first', '--expect', old])
    expect(stale.code).toBe(2)
    expect(stale.all).toContain('changed')
    expect(existsSync(join(b, code('first')))).toBe(false)
    expect((await decide('first')).code).toBe(0)
    expect(await read(b, code('first'))).toBe('firstV2()')
    expect(existsSync(join(b, code('second')))).toBe(false)
    expect((await cli(['code', '--dir', b, '--approve', 'second'])).code).toBe(2)
    expect((await decide('second', '--reject')).code).toBe(0)
  })

  it('does not install restored code through either single restore or bulk restore', async () => {
    const client = clientFor(a)
    const item = await remoteHead(code('first'))
    const versions = await client.versions(item.file_id)
    const old = versions.find((one) => one.version_id !== item.version_id)!
    const restored = await cli(['restore', code('first'), '--dir', b, '--version', old.version_id])
    expect(restored.code, restored.all).toBe(0)
    expect(await read(b, code('first'))).toBe('firstV2()')
    expect(restored.all).toContain('code awaiting approval')
    expect((await decide('first')).code).toBe(0)
    expect(await read(b, code('first'))).toBe('firstV1()')

    await write(a, code('trash-code'), 'restoredPlugin()')
    await syncOnce(a)
    const trash = await remoteHead(code('trash-code'))
    await client.commit(
      [{ op: 'delete', file_id: trash.file_id, base_version_id: trash.version_id }],
      'delete-plugin-code'
    )
    const bulk = await cli(['restore', '--dir', b, '--deleted-since', '1h'])
    expect(bulk.code, bulk.all).toBe(0)
    expect(existsSync(join(b, code('trash-code')))).toBe(false)
    expect(bulk.all).toContain('code awaiting approval')
    expect((await decide('trash-code')).code).toBe(0)
    expect(await read(b, code('trash-code'))).toBe('restoredPlugin()')
  })

  for (const action of ['delete', 'rename'] as const) {
    it(`holds the whole plugin group if it was locally ${action}d after staging`, async () => {
      const id = `local-${action}`
      await write(a, code(id), `${id}Before()`)
      await syncOnce(a)
      await syncOnce(b)
      expect((await decide(id)).code).toBe(0)
      await write(a, code(id), `${id}After()`)
      // New companion files must not recreate a folder whose installed main.js was moved/deleted.
      await write(a, code(id, 'manifest.json'), JSON.stringify({ id, version: '2.0.0' }))
      await write(a, code(id, 'styles.css'), 'body {}')
      await syncOnce(a)
      await syncOnce(b)
      const fingerprint = await listed(id)
      const localFolder = join(b, '.obsidian/plugins', id)
      if (action === 'delete') await rm(localFolder, { recursive: true })
      else await rename(localFolder, join(b, '.obsidian/plugins', `${id}-kept`))
      for (let attempt = 0; attempt < 2; attempt++) {
        const approval = await cli(['code', '--dir', b, '--approve', id, '--expect', fingerprint])
        expect(approval.code, approval.all).toBe(1)
        expect(approval.all).toContain('still held')
        expect(existsSync(localFolder)).toBe(false)
        expect(await listed(id)).toBe(fingerprint)
      }
      if (action === 'rename') expect(await read(b, code(`${id}-kept`))).toBe(`${id}Before()`)
    })
  }

  it('can approve absence already settled by a losing delete, rather than a new local deletion', async () => {
    const id = 'settled-delete-approval'
    await write(a, code(id), 'beforeDelete()')
    await syncOnce(a)
    await syncOnce(b)
    expect((await decide(id)).code).toBe(0)
    await rm(join(b, code(id)))
    await write(a, code(id), 'afterDelete()')
    await syncOnce(a)
    await syncOnce(b)
    expect(existsSync(join(b, code(id)))).toBe(false)
    const approval = await decide(id)
    expect(approval.code, approval.all).toBe(0)
    expect(await read(b, code(id))).toBe('afterDelete()')
  })

  it('takes the vault lock for decisions and leaves an edited local file untouched', async () => {
    await write(a, code('locked'), 'newCode()')
    await syncOnce(a)
    await syncOnce(b)
    const fingerprint = await listed('locked')
    const release = await acquireLock(b)
    try {
      expect((await cli(['code', '--dir', b])).code).toBe(0)
      const blocked = await cli([
        'code',
        '--dir',
        b,
        '--approve',
        'locked',
        '--expect',
        fingerprint,
      ])
      expect(blocked.code).toBe(3)
      expect(existsSync(join(b, code('locked')))).toBe(false)
    } finally {
      release()
    }
    await write(b, code('locked'), 'localUnsentCode()')
    const blocked = await decide('locked')
    expect(blocked.code).toBe(1)
    expect(await read(b, code('locked'))).toBe('localUnsentCode()')
    expect(await listed('locked')).toBe(fingerprint)
    expect((await decide('locked', '--reject')).code).toBe(0)
  })

  it('stages the verdict when a local plugin deletion loses, even on the next run', async () => {
    await write(a, code('delete-race'), 'beforeDelete()')
    await syncOnce(a)
    await syncOnce(b)
    expect((await decide('delete-race')).code).toBe(0)
    await rm(join(b, code('delete-race')))
    await write(a, code('delete-race'), 'afterDelete()')
    await syncOnce(a)
    await syncOnce(b)
    expect(existsSync(join(b, code('delete-race')))).toBe(false)
    await syncOnce(b)
    expect(existsSync(join(b, code('delete-race')))).toBe(false)
    expect((await decide('delete-race', '--reject')).code).toBe(0)
    await syncOnce(b)
    expect(await remoteHead(code('delete-race'))).toMatchObject({ path: code('delete-race') })
  })

  it('requires both plugin names before approving an accepted-unchanged server move', async () => {
    const source = code('move-source'),
      target = code('move-target')
    await write(a, source, 'beforeMove()')
    await syncOnce(a)
    await syncOnce(b)
    expect((await decide('move-source')).code).toBe(0)
    const old = await remoteHead(source)
    const moved = await clientFor(a).commit(
      [{ op: 'move', file_id: old.file_id, base_version_id: old.version_id, to_path: target }],
      'move-code'
    )
    expect(moved.results[0]?.status).toBe('applied')
    await write(b, source, 'localMovedCode()')
    await syncOnce(b)
    expect(await read(b, source)).toBe('localMovedCode()')
    expect(existsSync(join(b, target))).toBe(false)
    const fingerprint = await listed('move-source,move-target')
    expect(
      (await cli(['code', '--dir', b, '--approve', 'move-source', '--expect', fingerprint])).code
    ).toBe(2)
    const approved = await cli([
      'code',
      '--dir',
      b,
      '--approve',
      'move-source',
      'move-target',
      '--expect',
      fingerprint,
    ])
    expect(approved.code, approved.all).toBe(0)
    expect(existsSync(join(b, source))).toBe(false)
    expect(await read(b, target)).toBe('localMovedCode()')
  })

  it('does not install the server winner over local code during a join', async () => {
    await write(a, code('joining'), 'serverAtJoin()')
    await syncOnce(a)
    const c = await folder()
    await write(c, code('joining'), 'localAtJoin()')
    const init = await cli(
      [
        'init',
        '--dir',
        c,
        '--server',
        server.url,
        '--email',
        EMAIL,
        '--vault',
        'Plugin confirmation',
        '--prefer',
        'server',
      ],
      { ABELE_PASSWORD: PASSWORD }
    )
    expect(init.code, init.all).toBe(0)
    expect(config(c).joinPrefer).toBe('theirs')
    await syncOnce(c)
    expect(await read(c, code('joining'))).toBe('localAtJoin()')
    await syncOnce(c)
    expect(await read(c, code('joining'))).toBe('localAtJoin()')
    expect((await decide('joining', '--approve', c)).code).toBe(0)
    expect(await read(c, code('joining'))).toBe('serverAtJoin()')
  })

  it('keeps Abele code and data outside the other-plugin confirmation lane', async () => {
    await write(a, code('abele'), 'ownPlugin()')
    await write(a, code('abele', 'data.json'), '{"own":true}')
    await syncOnce(a)
    await syncOnce(b)
    expect(await read(b, code('abele'))).toBe('ownPlugin()')
    expect(await read(b, code('abele', 'data.json'))).toBe('{"own":true}')
  })
})
