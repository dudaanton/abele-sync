import { cp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { createUser } from '../../src/access/tokens.js'
import { runAdmin } from '../../src/admin-cli/index.js'
import { generationPath, pruneRestoreCheckpoint } from '../../src/restoreGeneration.js'
import { v2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { PG_TEST_URL } from '../helpers/tempDb.js'

it('pruning missing vaults preserves rollback evidence for surviving vaults', async () => {
  const server = await v2Server()
  try {
    const deps = { db: server.db, pepper: server.config.tokenPepper }
    const a = new V2SyncClient((await createUser(deps, 'A', server.address)).token)
    const b = new V2SyncClient((await createUser(deps, 'B', server.address)).token)
    await a.create('A.md', 'a')
    await b.create('B.md', 'b')
    const path = generationPath(server.config.blobDir)
    const previous = JSON.parse(await readFile(path, 'utf8'))
    const aId = (await a.json('/connection')).space_id
    const bId = (await b.json('/connection')).space_id
    await server.db.deleteFrom('vault_seq').where('vault_id', '=', aId).execute()
    await server.db
      .updateTable('vault_seq')
      .set({ head_seq: 0 })
      .where('vault_id', '=', bId)
      .execute()
    await pruneRestoreCheckpoint(server.db, path)
    const pruned = JSON.parse(await readFile(path, 'utf8'))
    expect(pruned.heads[aId]).toBeUndefined()
    expect(pruned.heads[bId]).toEqual(previous.heads[bId])
    expect(pruned.generation).toBe(previous.generation)
    await server.restart()
    const response = await b.request('/connection')
    expect(response.headers.get('abele-restore-generation')).not.toBe(previous.generation)
    await response.arrayBuffer()
  } finally {
    await server.close()
  }
})

for (const dialect of ['sqlite', 'pg'] as const)
  for (const removal of ['operator purge', 'retention', 'vault delete', 'missing checkpoint vault'])
    it.skipIf(dialect === 'pg' && !PG_TEST_URL)(
      `${dialect}: ${removal} does not rotate another vault's generation`,
      async () => {
        const server = await v2Server(dialect)
        try {
          const deps = { db: server.db, pepper: server.config.tokenPepper }
          const a = new V2SyncClient((await createUser(deps, 'A', server.address)).token)
          const b = new V2SyncClient((await createUser(deps, 'B', server.address)).token)
          await a.create('A.md', 'a')
          const file = await b.create('Deleted.md', 'offline client still holds these bytes')
          if (file.status === 'rejected') throw new Error(file.message)
          await b.commit([
            { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
          ])
          const old = await b.request('/connection')
          const generation = old.headers.get('abele-restore-generation')
          await old.arrayBuffer()
          const id = (await a.json('/connection')).space_id
          const env = {
            ABELE_DATABASE_URL: server.databaseUrl,
            ABELE_BLOB_DIR: server.config.blobDir,
            ABELE_MASTER_KEY: 'ab'.repeat(32),
            ABELE_TOKEN_PEPPER: server.config.tokenPepper,
          }
          const cli = async (args: string[]) => {
            const errors: string[] = []
            const code = await runAdmin(args, env, { log: () => {}, error: (s) => errors.push(s) })
            expect(errors).toEqual([])
            expect(code).toBe(0)
          }
          if (removal === 'missing checkpoint vault')
            await server.db.deleteFrom('vault_seq').where('vault_id', '=', id).execute()
          else if (removal === 'operator purge')
            await cli(['vaults', 'delete', id, '--now', '--confirm-purge', '--yes'])
          else {
            await cli(['vaults', 'delete', id, '--yes'])
            if (removal === 'retention') {
              await server.db
                .updateTable('spaces')
                .set({ deleted_at: '2000-01-01T00:00:00.000Z' })
                .where('id', '=', id)
                .execute()
              await cli(['gc'])
            }
          }
          if (removal === 'operator purge' || removal === 'retention') {
            const checkpoint = JSON.parse(
              await readFile(generationPath(server.config.blobDir), 'utf8')
            )
            expect(checkpoint.heads[id]).toBeUndefined()
          }
          await server.restart()
          const current = await b.request('/connection')
          expect(current.headers.get('abele-restore-generation')).toBe(generation)
          await current.arrayBuffer()
          expect((await b.manifest()).items).toEqual([])
        } finally {
          await server.close()
        }
      }
    )

it('restore checkpoint stays outside a blob directory with a trailing separator', () => {
  expect(generationPath('/disposable/blobs/')).toBe('/disposable/blobs.restore-head.json')
})

it('H05 detects divergent equal-head directory histories as well as file versions', async () => {
  const server = await v2Server()
  try {
    const root = await createUser(
      { db: server.db, pepper: server.config.tokenPepper },
      'Owner',
      server.address
    )
    const owner = new V2SyncClient(root.token)
    const directory = (await owner.commit([{ op: 'mkdir', path: 'Empty' }])).results[0]!
    if (directory.status === 'rejected') throw new Error(directory.message)
    const old = await owner.request('/connection')
    const generation = old.headers.get('abele-restore-generation')
    await old.arrayBuffer()
    // Equal cursor, but another incarnation of the directory head was restored.
    await server.db
      .updateTable('directories')
      .set({ version_id: 'another-directory-head' })
      .where('id', '=', directory.file_id)
      .execute()
    await server.restart()
    const current = await owner.request('/connection')
    expect(current.headers.get('abele-restore-generation')).not.toBe(generation)
    await current.arrayBuffer()
  } finally {
    await server.close()
  }
})

for (const dialect of ['sqlite', 'pg'] as const)
  it.skipIf(dialect === 'pg' && !PG_TEST_URL)(
    `H05 ${dialect}: generation survives restart; operator bump fences stale writes and receipt replays`,
    async () => {
      const server = await v2Server(dialect)
      try {
        const root = await createUser(
          { db: server.db, pepper: server.config.tokenPepper, dialect },
          'Owner',
          server.address
        )
        const owner = new V2SyncClient(root.token)
        const response = await owner.request('/connection')
        const old = response.headers.get('abele-restore-generation')!
        await response.arrayBuffer()
        expect(old).toMatch(/^[a-f0-9-]{36}$/)
        await owner.create('Keep.md', 'keep')
        const receiptBody = { ops: [{ op: 'mkdir', path: 'Receipt' }] }
        await owner.json('/commit', 'POST', receiptBody, {
          'idempotency-key': 'outstanding-receipt',
        })
        const before = (await owner.manifest()).cursor
        await server.restart(async () => {
          const lines: string[] = []
          expect(
            await runAdmin(
              ['restore-generation'],
              {
                ABELE_DATABASE_URL: server.databaseUrl,
                ABELE_BLOB_DIR: server.config.blobDir,
                ABELE_MASTER_KEY: 'ab'.repeat(32),
                ABELE_TOKEN_PEPPER: server.config.tokenPepper,
              },
              { log: (s) => lines.push(s), error: (s) => lines.push(s) }
            )
          ).toBe(0)
          expect(lines.join('')).toContain('restore generation:')
        })
        const stale = await owner.request('/commit', 'POST', receiptBody, {
          'abele-restore-generation': old,
          'idempotency-key': 'outstanding-receipt',
        })
        expect(stale.status).toBe(409)
        const current = stale.headers.get('abele-restore-generation')!
        expect(current).not.toBe(old)
        await stale.arrayBuffer()
        expect((await owner.manifest()).cursor).toBe(before)
        await server.restart()
        const unchanged = await owner.request('/connection')
        expect(unchanged.headers.get('abele-restore-generation')).toBe(current)
        await unchanged.arrayBuffer()
      } finally {
        await server.close()
      }
    }
  )

it('H05 equal-head divergent history is detected; unreadable checkpoint stops startup', async () => {
  const server = await v2Server()
  try {
    const root = await createUser(
      { db: server.db, pepper: server.config.tokenPepper },
      'Owner',
      server.address
    )
    const owner = new V2SyncClient(root.token)
    await owner.create('Original.md', 'old')
    const backup = join(server.dir, 'backup.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server.db)
    const original = (await owner.manifest()).items[0]!
    await owner.commit([
      {
        op: 'modify',
        file_id: original.file_id,
        base_version_id: original.version_id,
        ...(await owner.upload(Buffer.from('new'))),
        mtime: 1,
      },
    ])
    const old = await owner.request('/connection')
    const generation = old.headers.get('abele-restore-generation')
    await old.arrayBuffer()
    // Restore then create a divergent history with the same numeric head before startup.
    await server.restart(async () => {
      await cp(backup, join(server.dir, 'server.db'))
      const { createDb } = await import('../../src/db/connect.js')
      const handle = createDb(server.databaseUrl)
      try {
        const prior = await handle.db
          .selectFrom('versions')
          .selectAll()
          .where('id', '=', original.version_id)
          .executeTakeFirstOrThrow()
        const id = 'restored-divergent-head'
        await handle.db
          .insertInto('versions')
          .values({ ...prior, id, seq: 2, no: 2, op: 'modify', prev_version_id: prior.id })
          .execute()
        await handle.db
          .updateTable('files')
          .set({ head_version_id: id })
          .where('id', '=', original.file_id)
          .execute()
        await handle.db.updateTable('vault_seq').set({ head_seq: 2 }).execute()
      } finally {
        await handle.close()
      }
    })
    const now = await owner.request('/connection')
    expect(now.headers.get('abele-restore-generation')).not.toBe(generation)
    await now.arrayBuffer()
    await writeFile(generationPath(server.config.blobDir), '{broken')
    await expect(server.restart()).rejects.toThrow()
  } finally {
    await server.close()
  }
})
