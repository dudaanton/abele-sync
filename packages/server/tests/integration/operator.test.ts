import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { runAdmin } from '../../src/admin-cli/index.js'
import { runRetention } from '../../src/history/retention.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { v2Server } from '../helpers/v2Server.js'
import { createUser } from '../../src/access/tokens.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    it('operator issuance preserves configured private-directory boundaries', async () => {
      const t = await v2Server(dialect, { configurationDirectories: ['Config'] })
      try {
        const issued = await createUser(
          { db: t.db, pepper: t.config.tokenPepper },
          'Owner',
          t.address
        )
        await new V2SyncClient(issued.token).create('Config/private.md', 'private')
        const lines: string[] = []
        expect(
          await runAdmin(
            ['connections', 'create', 'Owner', '--folder', 'Config', '--label', 'Guest', '--json'],
            {
              ABELE_DATABASE_URL: t.databaseUrl,
              ABELE_BLOB_DIR: t.config.blobDir,
              ABELE_MASTER_KEY: 'ab'.repeat(32),
              ABELE_TOKEN_PEPPER: t.config.tokenPepper,
              ABELE_CONFIGURATION_DIRS: JSON.stringify(['Config']),
            },
            { log: (s) => lines.push(s), error: () => {} }
          )
        ).toBe(0)
        const guest = new V2SyncClient(JSON.parse(lines[0]!).token)
        expect((await guest.manifest()).items).toEqual([])
      } finally {
        await t.close()
      }
    })
    it('operator resolves names, refuses ambiguous labels and manages vaults and connections', async () => {
      const f = await tokenFixture(dialect)
      const env = {
        ABELE_DATABASE_URL: f.t.databaseUrl,
        ABELE_BLOB_DIR: f.t.config.blobDir,
        ABELE_MASTER_KEY: 'ab'.repeat(32),
        ABELE_TOKEN_PEPPER: f.t.config.tokenPepper,
      }
      const cli = async (...args: string[]) => {
        const lines: string[] = [],
          errors: string[] = []
        const code = await runAdmin(args, env, {
          log: (s) => lines.push(s),
          error: (s) => errors.push(s),
        })
        return { code, text: lines.join('\n'), errors: errors.join('\n') }
      }
      try {
        expect(JSON.parse((await cli('vaults', 'list', '--json')).text)[0].last_change).toEqual(
          expect.any(String)
        )
        const note = success(await f.root.create('Agents/a.md', 'hello'))
        expect((await cli('vaults', 'list', '--json')).code).toBe(0)
        expect(JSON.parse((await cli('vaults', 'list', '--json')).text)[0]).toMatchObject({
          name: 'Owner',
          file_count: 1,
          bytes: 5,
        })
        expect((await cli('vaults', 'rename', 'Owner', 'Work')).code).toBe(0)
        const duplicate = JSON.parse(
          (await cli('vaults', 'create', 'Work', '--address', f.t.address, '--json')).text
        )
        const other = (
          await f.t.db
            .selectFrom('access_tokens')
            .select('space_id')
            .where('id', '=', duplicate.info.id)
            .executeTakeFirstOrThrow()
        ).space_id
        const ambiguousVault = await cli('vaults', 'show', 'Work')
        expect(ambiguousVault.code).toBe(1)
        expect(ambiguousVault.errors).toContain(f.space)
        expect(ambiguousVault.errors).toContain(other)
        expect((await cli('vaults', 'show', f.space, '--json')).code).toBe(0)
        expect(
          (await cli('vaults', 'delete', other, '--now', '--confirm-purge', '--yes')).code
        ).toBe(0)
        expect(JSON.parse((await cli('vaults', 'show', 'Work', '--json')).text).folders).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: 'Agents', file_count: 1 })])
        )
        expect((await cli('connections', 'rename', f.share.info.id, 'Laptop')).code).toBe(0)
        const group = JSON.parse(
          (
            await cli(
              'connections',
              'create',
              'Work',
              '--group',
              note.file_id,
              '--label',
              'Group',
              '--json'
            )
          ).text
        )
        expect(group.info.scope).toMatchObject({
          kind: 'group',
          id: note.file_id,
          path: 'Agents/a.md',
        })
        expect(
          (
            await new V2SyncClient(group.token).request('/folders/delete', 'POST', {
              path: 'Agents',
            })
          ).status
        ).toBe(404)
        expect((await cli('connections', 'revoke', 'Group')).code).toBe(0)
        expect((await new V2SyncClient(group.token).request('/connection')).status).toBe(401)
        const listed = JSON.parse(
          (await cli('connections', 'list', '--vault', 'Work', '--json')).text
        )
        expect(listed.every((t: { vault_id: string }) => t.vault_id === f.space)).toBe(true)
        expect(JSON.stringify(listed)).not.toMatch(/secret_hash|synthetic-v2/)
        expect(
          JSON.parse((await cli('activity', '--connection', group.info.id, '--json')).text).events
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ action: 'connection.revoke' })])
        )
        expect(
          JSON.parse((await cli('connections', 'show', 'Laptop', '--json')).text)
        ).toMatchObject({ label: 'Laptop', scope: { path: 'Agents' } })
        expect(
          (
            await cli(
              'connections',
              'create',
              'Work',
              '--folder',
              'Agents',
              '--label',
              'Laptop',
              '--json'
            )
          ).code
        ).toBe(0)
        const ambiguous = await cli('connections', 'revoke', 'Laptop')
        expect(ambiguous.code).toBe(1)
        expect(ambiguous.errors).toContain(f.share.info.id)
        expect((await cli('folders', 'delete', 'Work', 'Agents', '--yes')).code).toBe(0)
        const activity = await cli('activity', '--vault', 'Work', '--limit', '2', '--json')
        expect(activity.code).toBe(0)
        expect(JSON.parse(activity.text).events).toHaveLength(2)
        expect((await cli('activity', '--since', 'invalid')).code).toBe(1)
        expect((await cli('activity', '--limit', '0')).code).toBe(1)
        if (!process.stdin.isTTY) expect((await cli('vaults', 'delete', 'Work')).code).toBe(1)
        expect((await f.root.request('/manifest')).status).toBe(200)
        expect((await cli('vaults', 'delete', 'Work', '--now', '--yes')).code).toBe(1)
        expect((await cli('vaults', 'delete', 'Work', '--yes')).code).toBe(0)
        expect((await f.root.request('/manifest')).status).toBe(401)
        const sweep = (now: Date) =>
          runRetention({
            db: f.t.db,
            dialect,
            store: f.t.store,
            uploads: createUploadManager({
              config: f.t.config,
              db: f.t.db,
              store: f.t.store,
              dialect,
            }),
            idempotencyTtlMs: 1000,
            now: () => now,
          })
        await sweep(new Date())
        expect(await f.t.db.selectFrom('spaces').selectAll().execute()).toHaveLength(1)
        await sweep(new Date('2100-01-01'))
        expect(await f.t.db.selectFrom('spaces').selectAll().execute()).toHaveLength(0)
        expect(await f.t.db.selectFrom('versions').selectAll().execute()).toHaveLength(0)
        expect(await f.t.db.selectFrom('access_tokens').selectAll().execute()).toHaveLength(0)
        expect((await cli('activity', '--vault', f.space, '--json')).code).toBe(0)
        expect((await cli('activity', '--connection', f.share.info.id, '--json')).code).toBe(0)
        const immediate = await cli(
          'vaults',
          'create',
          'Immediate',
          '--address',
          f.t.address,
          '--json'
        )
        expect(immediate.code).toBe(0)
        const immediateClient = new V2SyncClient(JSON.parse(immediate.text).token)
        const unique = success(
          await immediateClient.create('unique.md', 'purge these unique bytes')
        )
        const survivor = JSON.parse(
          (await cli('vaults', 'create', 'Survivor', '--address', f.t.address, '--json')).text
        )
        const survivorClient = new V2SyncClient(survivor.token)
        const shared = success(await survivorClient.create('shared.md', 'shared bytes'))
        await immediateClient.create('shared.md', 'shared bytes')
        const purged = await cli(
          'vaults',
          'delete',
          'Immediate',
          '--now',
          '--confirm-purge',
          '--yes',
          '--json'
        )
        expect(purged.code).toBe(0)
        expect(JSON.parse(purged.text).status).toBe('purged')
        expect(await f.t.store.has(unique.sha!)).toBe(false)
        expect(await f.t.store.has(shared.sha!)).toBe(true)
        expect((await survivorClient.content(shared.file_id)).toString()).toBe('shared bytes')
        expect(
          JSON.parse(
            (await cli('user', 'create', '--label', 'JsonUser', '--address', f.t.address, '--json'))
              .text
          ).info.label
        ).toBe('JsonUser')
        expect(JSON.parse((await cli('gc', '--json')).text)).toHaveProperty('versions_removed')
        if (dialect === 'sqlite')
          expect(
            JSON.parse((await cli('backup', '--to', f.t.dir + '/backup', '--json')).text).verified
          ).toBe(true)
      } finally {
        await f.close()
      }
    })
  })
