import { cp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { createDb } from '@abele/sync-server/src/db/connect.js'
import { PG_TEST_URL } from '@abele/sync-server/tests/helpers/tempDb.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'
import {
  GENERATION_KEY,
  RECONCILING_KEY,
  requestReconciliation,
  readReconciliation,
} from '../../src/index.js'

it('retires a tracked-file pull interrupted before installation after a server restore', async () => {
  const f = await acceptanceFixture()
  try {
    const server = f.servers[0]!,
      a = f.devices[0]!
    const owner = new V2SyncClient(f.roots[0]!.token)
    await a.write('Note.bin', 'backup bytes')
    await a.sync('server-1')
    const backup = join(server.dir, 'pending-pull-backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
    const state = a.connection('server-1').binding.state
    const base = (await state.get('Note.bin'))!
    const generation = await state.getMeta(GENERATION_KEY)
    const blob = await owner.upload(Buffer.from('later remote bytes'))
    await owner.commit([
      { op: 'modify', file_id: base.fileId, base_version_id: base.versionId, ...blob, mtime: 1234 },
    ])
    const save = state.setMeta.bind(state)
    state.setMeta = (key, value) => {
      save(key, value)
      if (key.startsWith('pull-write:') && value) throw new Error('interrupted tracked pull')
    }
    await expect(a.sync('server-1')).rejects.toThrow('interrupted tracked pull')
    state.setMeta = save
    const intent = state.getMeta(`pull-write:${base.fileId}`)!
    expect(JSON.parse(intent).base).toEqual(base)
    await server.restart(async () => {
      await cp(backup, join(server.dir, 'server.db'))
    })
    await a.restart()
    const restarted = a.connection('server-1').binding
    await restarted.client.prepare!(a.fs, restarted.state)
    await recoverPendingPullWrites(
      a.fs,
      restarted.state,
      restarted.state.metadataKeys('pull-write:').map((key) => key.slice('pull-write:'.length)),
      restarted.client
    )
    expect(restarted.state.getMeta(`pull-write:${base.fileId}`)).toBeNull()
    expect(
      JSON.parse(restarted.state.getMeta(`retired-generation:${generation}`)!).metadata[
        `pull-write:${base.fileId}`
      ]
    ).toBe(intent)
    await a.sync('server-1')
    expect((await readReconciliation(restarted.state))?.phase).toBe('complete')
    expect(await a.text('Note.bin')).toBe('backup bytes')
    expect((await owner.content(base.fileId)).toString()).toBe('backup bytes')
  } finally {
    await f.close()
  }
})

it('keeps both generation variants when restored local content equals its retired ledger digest', async () => {
  const f = await acceptanceFixture()
  try {
    const server = f.servers[0]!
    const a = f.devices[0]!
    const owner = new V2SyncClient(f.roots[0]!.token)
    await a.write('Note.bin', 'old profile bytes')
    await a.sync('server-1')
    const file = (await owner.manifest()).items.find((item) => item.path === 'Note.bin')!
    const blob = await owner.upload(Buffer.from('newer server bytes'))
    await owner.commit([
      {
        op: 'modify',
        file_id: file.file_id,
        base_version_id: file.version_id,
        ...blob,
        mtime: Date.now() + 1000,
      },
    ])
    const backup = join(server.dir, 'matching-profile-backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
    await owner.create('After-backup.md', 'after backup')
    await a.fs.writeAtomic('Note.bin', new TextEncoder().encode('old profile bytes'), 1)
    await server.restart(async () => {
      await cp(backup, join(server.dir, 'server.db'))
    })
    await a.sync('server-1')
    const items = (await owner.manifest()).items.filter((i) => i.kind !== 'directory')
    const remote = await Promise.all(
      items.map(async (i) => (await owner.content(i.file_id)).toString())
    )
    expect(remote.sort()).toEqual(['newer server bytes', 'old profile bytes'])
    const local = await Promise.all(items.map((i) => a.text(i.path)))
    expect(local.sort()).toEqual(remote.sort())
  } finally {
    await f.close()
  }
})

it('combines a server generation change and restored local vault into one conservative content reconciliation', async () => {
  const f = await acceptanceFixture()
  try {
    const server = f.servers[0]!
    const a = f.devices[0]!
    const owner = new V2SyncClient(f.roots[0]!.token)
    await a.write('Note.bin', 'server backup variant')
    await a.write('Keep.md', 'must not be deleted\n')
    await a.sync('server-1')
    const backup = join(server.dir, 'combined-backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
    await a.write('Note.bin', 'current ledger variant')
    await a.sync('server-1')
    const state = a.connection('server-1').binding.state
    const oldGeneration = await state.getMeta(GENERATION_KEY)
    const absent = (await state.get('Keep.md'))!
    await state.setJournal({
      batchId: randomUUID(),
      idempotencyKey: randomUUID(),
      startedAt: new Date().toISOString(),
      ops: [{ op: 'delete', file_id: absent.fileId, base_version_id: absent.versionId }],
    })
    await requestReconciliation(state, 'restored local vault requested before connecting')
    await a.fs.writeAtomic('Note.bin', new TextEncoder().encode('restored local edit'), 1)
    await a.delete('Keep.md')
    await server.restart(async () => {
      await cp(backup, join(server.dir, 'server.db'))
    })
    let requests = 0
    const setMeta = state.setMeta.bind(state)
    state.setMeta = (key, value) => {
      if (key === 'content-reconciliation' && value && JSON.parse(value).phase === 'requested')
        requests++
      return setMeta(key, value)
    }
    const report = await a.sync('server-1')
    expect(report.joined).toBe(false)
    expect(requests).toBe(1)
    const reconciliation = await readReconciliation(state)
    expect(reconciliation?.phase).toBe('complete')
    expect(reconciliation?.reason).toContain('generation')
    expect(reconciliation?.reason).toContain('older timestamps')
    expect(await state.getMeta(RECONCILING_KEY)).toBeNull()
    expect(await state.getMeta(GENERATION_KEY)).not.toBe(oldGeneration)
    expect(await state.getMeta(`retired-generation:${oldGeneration}`)).toContain('delete')
    expect(await state.getJournal()).toBeNull()
    expect(await a.connection('server-1').binding.engine.heldDeletes()).toEqual([])
    const items = (await owner.manifest()).items.filter((i) => i.kind !== 'directory')
    const remote = await Promise.all(
      items.map(async (i) => (await owner.content(i.file_id)).toString())
    )
    expect(remote.sort()).toEqual(
      ['must not be deleted\n', 'restored local edit', 'server backup variant'].sort()
    )
    const local = await Promise.all(items.map((i) => a.text(i.path)))
    expect(local.sort()).toEqual(remote.sort())
    expect(
      await server.db.selectFrom('versions').select('id').where('op', '=', 'delete').execute()
    ).toEqual([])
    const count = (await server.db.selectFrom('versions').select('id').execute()).length
    await a.restart()
    await a.sync('server-1')
    expect((await server.db.selectFrom('versions').select('id').execute()).length).toBe(count)
    expect((await readReconciliation(a.connection('server-1').binding.state))?.phase).toBe(
      'complete'
    )
  } finally {
    await f.close()
  }
})

for (const dialect of ['sqlite', 'pg'] as const)
  it.skipIf(dialect === 'pg' && !PG_TEST_URL)(
    `H05 ${dialect}: restored server recovers lost bytes without replaying pending deletes at a reused cursor`,
    async () => {
      const f = await acceptanceFixture(dialect)
      const clone = `restore_backup_${randomUUID().replaceAll('-', '')}`
      const pgAdmin = dialect === 'pg' ? createDb(PG_TEST_URL) : undefined
      try {
        const server = f.servers[0]!
        const [a, b] = f.devices
        const owner = new V2SyncClient(f.roots[0]!.token)
        await a!.write('Keep.md', 'keep me\n')
        await a!.sync('server-1')
        await b!.sync('server-1')
        const backup = join(server.dir, 'backup.db')
        if (pgAdmin) {
          const name = new URL(server.databaseUrl).pathname.slice(1)
          await server.restart(async () => {
            await sql.raw(`create database "${clone}" template "${name}"`).execute(pgAdmin.db)
          })
        } else await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
        const blobs = join(server.dir, 'backup-blobs')
        await cp(server.config.blobDir, blobs, { recursive: true })
        await a!.write('Lost.md', 'newer local bytes\n')
        await a!.sync('server-1')
        await b!.sync('server-1')
        await a!.fs.remove('Keep.md')
        a!.network.dropNextResponse(
          (url, method) => url.endsWith('/v2/commit') && method === 'POST'
        )
        await expect(a!.sync('server-1')).rejects.toThrow()
        expect(await a!.connection('server-1').binding.state.getJournal()).not.toBeNull()
        await server.restart(async () => {
          if (pgAdmin) {
            const name = new URL(server.databaseUrl).pathname.slice(1)
            await sql.raw(`drop database "${name}"`).execute(pgAdmin.db)
            await sql.raw(`create database "${name}" template "${clone}"`).execute(pgAdmin.db)
          } else await cp(backup, join(server.dir, 'server.db'))
          await rm(server.config.blobDir, { recursive: true })
          await cp(blobs, server.config.blobDir, { recursive: true })
        })
        await b!.restart()
        await b!.sync('server-1')
        await owner.create('Other.md', 'server-only bytes\n')
        await owner.create('Another.md', 'server-only too\n')
        await a!.restart()
        for (let round = 0; round < 4; round++) {
          await a!.sync('server-1')
          await b!.sync('server-1')
        }
        const items = (await owner.manifest()).items
        expect(items.map((i) => i.path).sort()).toEqual([
          'Another.md',
          'Keep.md',
          'Lost.md',
          'Other.md',
        ])
        for (const device of [a!, b!]) {
          expect(await device.text('Keep.md')).toBe('keep me\n')
          expect(await device.text('Lost.md')).toBe('newer local bytes\n')
          expect(await device.text('Other.md')).toBe('server-only bytes\n')
        }
        expect(
          await server.db.selectFrom('versions').select('id').where('op', '=', 'delete').execute()
        ).toEqual([])
        expect(await a!.connection('server-1').binding.state.getJournal()).toBeNull()
        const lost = items.find((i) => i.path === 'Lost.md')!
        expect((await owner.content(lost.file_id)).toString()).toBe('newer local bytes\n')
      } finally {
        await f.close()
        if (pgAdmin) {
          await sql.raw(`drop database if exists "${clone}"`).execute(pgAdmin.db)
          await pgAdmin.close()
        }
      }
    },
    // PostgreSQL template copies and reconnects run on the bounded disposable SQL server.
    60_000
  )

it('H05 group recovery republishes only formerly shared files and keeps private neighbors local', async () => {
  const f = await acceptanceFixture()
  try {
    const server = f.servers[0]!
    const owner = new V2SyncClient(f.roots[0]!.token)
    const root = await owner.create('Group.md', 'group root')
    if (root.status === 'rejected') throw new Error(root.message)
    const token = await owner.json('/tokens', 'POST', {
      scope: { kind: 'group', id: root.file_id },
      label: 'Group',
    })
    const a = f.devices[0]!
    for (const id of [...a.connections.keys()]) await a.disconnect(id)
    await a.paste(token.token, 'group')
    await a.sync('group')
    const backup = join(server.dir, 'backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
    const member = '---\ngroups: ["[[Group]]"]\n---\nmember\n'
    await a.write('Member.md', member)
    await a.write('Private.md', 'private note')
    await a.write('Private.png', 'private image')
    await a.sync('group')
    const client = a.connection('group').binding.client as V2EngineClient
    await a.write('Shared.png', 'shared image')
    await client.publishGroupAsset('Shared.png', Buffer.from('shared image'), 1000, 'asset-consent')
    await a.sync('group')
    await server.restart(async () => {
      await cp(backup, join(server.dir, 'server.db'))
    })
    // Keep the client object alive as well as its durable ledger.
    for (let round = 0; round < 4; round++) await a.sync('group')
    expect((await owner.manifest()).items.map((i) => i.path).sort()).toEqual([
      'Group.md',
      'Member.md',
      'Shared.png',
    ])
    expect(await a.text('Member.md')).toBe(member)
    expect(await a.text('Shared.png')).toBe('shared image')
    expect(await a.text('Private.md')).toBe('private note')
    expect(await a.text('Private.png')).toBe('private image')
  } finally {
    await f.close()
  }
})

it('H05 reconciliation preserves divergent local bytes as well as the restored server variant', async () => {
  const f = await acceptanceFixture()
  try {
    const server = f.servers[0]!
    const a = f.devices[0]!
    const owner = new V2SyncClient(f.roots[0]!.token)
    await a.write('Note.md', 'original server bytes\n')
    await a.sync('server-1')
    const backup = join(server.dir, 'backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
    await a.write('Note.md', 'newer client bytes\n')
    await a.sync('server-1')
    await server.restart(async () => {
      await cp(backup, join(server.dir, 'server.db'))
    })
    for (let round = 0; round < 4; round++) await a.sync('server-1')
    const items = (await owner.manifest()).items.filter((i) => i.kind !== 'directory')
    expect(items).toHaveLength(2)
    const contents = await Promise.all(
      items.map(async (i) => (await owner.content(i.file_id)).toString())
    )
    expect(contents.sort()).toEqual(['newer client bytes\n', 'original server bytes\n'])
    const local = await Promise.all(items.map((i) => a.text(i.path)))
    expect(local.sort()).toEqual(contents.sort())
    expect(
      await server.db.selectFrom('versions').select('id').where('op', '=', 'delete').execute()
    ).toEqual([])
  } finally {
    await f.close()
  }
})
