import { describe, expect, it, vi } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { runAdmin } from '../../src/admin-cli/index.js'
import { decodeAccessToken } from '@abele/sync-protocol'
import { resolveName } from '../../src/admin-cli/operator.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'

it('resolves only exact IDs or unique complete names', () => {
  const rows = [
    { id: 'one', label: 'Laptop' },
    { id: 'two', label: 'Laptop' },
  ]
  expect(resolveName(rows, 'one', (r) => r.label).id).toBe('one')
  expect(() => resolveName(rows, 'Laptop', (r) => r.label)).toThrow('ambiguous')
  expect(() => resolveName(rows, 'Lap', (r) => r.label)).toThrow('not found')
  expect(() => resolveName(rows, 'on', (r) => r.label)).toThrow('not found')
})
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    it('keeps direct group issues manageable with hidden paths after escape, but denies indirect issues', async () => {
      const f = await tokenFixture(dialect)
      try {
        const index = success(await f.root.create('Index.md', 'index'))
        const member = success(
          await f.root.create('Member.md', '---\ngroups: ["[[Index]]"]\n---\nmember')
        )
        const issued = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: index.file_id },
          label: 'Group',
        })
        const group = new V2SyncClient(issued.token)
        const child = await group.json('/tokens', 'POST', {
          scope: { kind: 'group', id: member.file_id },
          label: 'Child',
        })
        const nested = await new V2SyncClient(child.token).json('/tokens', 'POST', {
          scope: { kind: 'group', id: member.file_id },
          label: 'Indirect child',
        })
        expect((await group.json('/tokens')).items).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: child.info.id })])
        )
        success(
          (
            await f.root.commit([
              {
                op: 'modify',
                file_id: member.file_id,
                base_version_id: member.version_id,
                ...(await f.root.upload(Buffer.from('no longer in the group'))),
                mtime: 2000,
              },
            ])
          ).results[0]!
        )
        const list = await group.json('/tokens')
        expect(list.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: child.info.id,
              scope: {
                kind: 'group',
                id: member.file_id,
                path: '(unavailable)',
              },
            }),
          ])
        )
        expect(JSON.stringify(list)).not.toContain('Member.md')
        expect(list.items).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: nested.info.id })])
        )
        expect((await group.request('/tokens/' + nested.info.id, 'DELETE')).status).toBe(403)
        expect((await group.request('/tokens/' + child.info.id, 'DELETE')).status).toBe(200)
        expect((await f.root.request('/tokens/' + nested.info.id, 'DELETE')).status).toBe(200)
      } finally {
        await f.close()
      }
    })

    it('prints an issued operator credential once and keeps it out of diagnostics, audit and listings', async () => {
      const f = await tokenFixture(dialect)
      const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const lines: string[] = [],
          diagnostics: string[] = []
        const env = {
          ABELE_DATABASE_URL: f.t.databaseUrl,
          ABELE_BLOB_DIR: f.t.config.blobDir,
          ABELE_MASTER_KEY: 'ab'.repeat(32),
          ABELE_TOKEN_PEPPER: f.t.config.tokenPepper,
        }
        const output = {
          log: (s: string) => lines.push(s),
          error: (s: string) => diagnostics.push(s),
        }
        expect(
          await runAdmin(
            ['connections', 'create', 'Owner', '--label', 'Once', '--json'],
            env,
            output
          )
        ).toBe(0)
        expect(lines).toHaveLength(1)
        const issued = JSON.parse(lines[0]!)
        const key = decodeAccessToken(issued.token).key
        expect(lines[0]!.split(issued.token)).toHaveLength(2)
        lines.length = 0
        expect(await runAdmin(['connections', 'list', '--json'], env, output)).toBe(0)
        const stored = JSON.stringify(await f.t.db.selectFrom('audit').selectAll().execute())
        for (const text of [
          lines.join(''),
          diagnostics.join(''),
          stored,
          JSON.stringify(logged.mock.calls),
          JSON.stringify(errors.mock.calls),
        ]) {
          expect(text).not.toContain(issued.token)
          expect(text).not.toContain(key)
          expect(text).not.toContain('secret_hash')
        }
      } finally {
        logged.mockRestore()
        errors.mockRestore()
        await f.close()
      }
    })

    it('requires explicit confirmation before operator connection revocation', async () => {
      const f = await tokenFixture(dialect)
      try {
        const env = {
          ABELE_DATABASE_URL: f.t.databaseUrl,
          ABELE_BLOB_DIR: f.t.config.blobDir,
          ABELE_MASTER_KEY: 'ab'.repeat(32),
          ABELE_TOKEN_PEPPER: f.t.config.tokenPepper,
        }
        const output = { log: () => {}, error: () => {} }
        if (!process.stdin.isTTY) {
          expect(await runAdmin(['connections', 'revoke', f.share.info.id], env, output)).toBe(1)
          expect((await f.guest.request('/connection')).status).toBe(200)
        }
        expect(
          await runAdmin(['connections', 'revoke', f.share.info.id, '--yes'], env, output)
        ).toBe(0)
        expect((await f.guest.request('/connection')).status).toBe(401)
      } finally {
        await f.close()
      }
    })

    it('keeps direct folder issues manageable with hidden paths after escape, but denies indirect issues', async () => {
      const f = await tokenFixture(dialect)
      try {
        const dir = success(
          (await f.root.commit([{ op: 'mkdir', path: 'Agents/Nested' }])).results[0]!
        )
        const child = await f.guest.share(dir.file_id)
        const nested = await new V2SyncClient(child.token).share(dir.file_id)
        expect((await f.guest.json('/tokens')).items).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: child.info.id })])
        )
        const root = await f.root.json('/connection')
        await f.t.db
          .updateTable('directories')
          .set({ path: 'Outside', parent_id: root.scope.id })
          .where('id', '=', dir.file_id)
          .execute()
        const list = await f.guest.json('/tokens')
        expect(list.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: child.info.id,
              scope: {
                kind: 'folder',
                id: dir.file_id,
                path: '(unavailable)',
              },
            }),
          ])
        )
        expect(JSON.stringify(list)).not.toContain('Outside')
        expect(list.items).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ id: nested.info.id })])
        )
        expect((await f.guest.request('/tokens/' + nested.info.id, 'DELETE')).status).toBe(403)
        expect(
          (
            await f.t.db
              .selectFrom('access_tokens')
              .select('revoked_at')
              .where('id', '=', nested.info.id)
              .executeTakeFirstOrThrow()
          ).revoked_at
        ).toBeNull()
        expect((await f.guest.request('/tokens/' + child.info.id, 'DELETE')).status).toBe(200)
        expect((await f.root.request('/tokens/' + nested.info.id, 'DELETE')).status).toBe(200)
      } finally {
        await f.close()
      }
    })
  })
