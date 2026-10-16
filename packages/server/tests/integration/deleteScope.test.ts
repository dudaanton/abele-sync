import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { sweepIdempotency } from '../../src/history/receipts.js'
import { runAdmin } from '../../src/admin-cli/index.js'
import WebSocket from 'ws'
import { sql } from 'kysely'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    it('rolls content, revocation, history and audit back if filing the receipt fails', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('Agents/a.md', 'hello'))
        if (dialect === 'pg') {
          await sql
            .raw(
              "create function fail_scope_receipt() returns trigger language plpgsql as $$ begin if new.request_hash = 'connection.delete:v1' then raise exception 'synthetic receipt fault'; end if; return new; end $$"
            )
            .execute(f.t.db)
          await sql
            .raw(
              'create trigger fail_scope_receipt before insert on idempotency for each row execute function fail_scope_receipt()'
            )
            .execute(f.t.db)
        } else {
          await sql
            .raw(
              "create trigger fail_scope_receipt before insert on idempotency when new.request_hash = 'connection.delete:v1' begin select raise(abort,'synthetic receipt fault'); end"
            )
            .execute(f.t.db)
        }
        const key = randomUUID()
        expect(
          (await f.guest.request('/connection/delete', 'POST', {}, { 'idempotency-key': key }))
            .status
        ).toBe(500)
        expect((await f.root.content(file.file_id)).toString()).toBe('hello')
        expect((await f.guest.manifest()).items.some((i) => i.file_id === file.file_id)).toBe(true)
        expect(
          await f.t.db
            .selectFrom('audit')
            .selectAll()
            .where('action', '=', 'connection.delete')
            .execute()
        ).toHaveLength(0)
        expect(
          await f.t.db
            .selectFrom('idempotency')
            .selectAll()
            .where('request_hash', '=', 'connection.delete:v1')
            .execute()
        ).toHaveLength(0)
        const token = await f.t.db
          .selectFrom('access_tokens')
          .select('revoked_at')
          .where('id', '=', f.share.info.id)
          .executeTakeFirstOrThrow()
        expect(token.revoked_at).toBeNull()
        expect(
          await f.t.db
            .selectFrom('activity_daily')
            .selectAll()
            .where('token_id', '=', f.share.info.id)
            .execute()
        ).toHaveLength(0)
        await sql
          .raw(
            dialect === 'pg'
              ? 'drop trigger fail_scope_receipt on idempotency'
              : 'drop trigger fail_scope_receipt'
          )
          .execute(f.t.db)
        expect(
          (await f.guest.json('/connection/delete', 'POST', {}, { 'idempotency-key': key })).files
        ).toBe(1)
      } finally {
        await f.close()
      }
    })
    it('folder self-deletion is atomic, restorable and replayable after revocation', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('Agents/sub/a.md', 'hello'))
        const keep = success(await f.root.create('AgentsExtra/keep.md', 'keep'))
        const dir = (await f.root.manifest()).items.find((i) => i.path === 'Agents/sub')!
        const child = await f.guest.share(dir.file_id)
        const sibling = await f.root.share(f.share.info.scope.id)
        const socket = new WebSocket(f.t.address.replace('http:', 'ws:') + '/v2/events', {
          headers: { authorization: 'Bearer ' + f.guest.key },
        })
        const frames: unknown[] = []
        socket.on('message', (data) => frames.push(JSON.parse(data.toString())))
        await new Promise<void>((resolve, reject) => {
          socket.once('message', () => resolve())
          socket.once('error', reject)
        })
        const closed = new Promise<number>((resolve) =>
          socket.once('close', (code) => resolve(code))
        )
        const key = randomUUID()
        const response = await f.guest.json(
          '/connection/delete',
          'POST',
          {},
          { 'idempotency-key': key }
        )
        expect(response.files).toBe(1)
        expect(response.revoked_tokens).toEqual(
          expect.arrayContaining([f.share.info.id, child.info.id, sibling.info.id])
        )
        expect(await closed).toBe(4004)
        expect(frames).toContainEqual({ type: 'connection', status: 'scope_deleted' })
        expect(
          await f.guest.json('/connection/delete', 'POST', {}, { 'idempotency-key': key })
        ).toEqual(response)
        await sweepIdempotency(f.t.db, new Date('2100-01-01'))
        expect(
          await f.guest.json('/connection/delete', 'POST', {}, { 'idempotency-key': key })
        ).toEqual(response)
        expect(
          (
            await f.guest.request(
              '/connection/delete',
              'POST',
              {},
              { 'idempotency-key': randomUUID() }
            )
          ).status
        ).toBe(401)
        expect(
          (
            await f.root.request(
              '/connection/delete',
              'POST',
              { path: 'AgentsExtra' },
              { 'idempotency-key': randomUUID() }
            )
          ).status
        ).toBe(400)
        expect((await f.root.request('/connection/delete', 'POST', {})).status).toBe(400)
        expect(
          (await f.root.request('/folders/delete', 'POST', { path: 'AgentsExtra' })).status
        ).toBe(404)
        expect((await f.root.content(keep.file_id)).toString()).toBe('keep')
        expect(JSON.stringify(await f.root.json('/trash'))).toContain(file.file_id)
        const audit = await f.t.db
          .selectFrom('audit')
          .selectAll()
          .where('action', '=', 'connection.delete')
          .execute()
        expect(audit).toHaveLength(1)
        expect(JSON.parse(audit[0]!.details).label).toBe('Shared')
        success(
          await f.root.json(
            '/files/' + file.file_id + '/restore',
            'POST',
            { deleted: true },
            { 'idempotency-key': randomUUID() }
          )
        )
        expect((await f.root.content(file.file_id)).toString()).toBe('hello')
        expect((await f.guest.request('/manifest')).status).toBe(401)
      } finally {
        await f.close()
      }
    })
    it('whole-vault self-deletion trashes all content and revokes every token without purging the vault', async () => {
      const f = await tokenFixture(dialect)
      try {
        const a = success(await f.root.create('Agents/a.md', 'a'))
        const b = success(await f.root.create('outside.md', 'b'))
        const before = (await f.t.db.selectFrom('access_tokens').select('id').execute()).map(
          (t) => t.id
        )
        const key = randomUUID()
        const results = await Promise.all([
          f.root.json('/connection/delete', 'POST', {}, { 'idempotency-key': key }),
          f.root.json('/connection/delete', 'POST', {}, { 'idempotency-key': key }),
        ])
        expect(results[0]).toEqual(results[1])
        expect(results[0].files).toBe(2)
        expect(results[0].revoked_tokens.sort()).toEqual(before.sort())
        expect(
          await f.t.db.selectFrom('files').selectAll().where('deleted_at', 'is', null).execute()
        ).toHaveLength(0)
        expect(
          (await f.t.db.selectFrom('spaces').selectAll().executeTakeFirstOrThrow()).deleted_at
        ).toBeNull()
        expect(await f.t.store.has(a.sha!)).toBe(true)
        expect(await f.t.store.has(b.sha!)).toBe(true)
        expect((await f.root.request('/manifest')).status).toBe(401)
        const lines: string[] = []
        expect(
          await runAdmin(
            ['connections', 'create', 'Owner', '--label', 'Recovery', '--json'],
            {
              ABELE_DATABASE_URL: f.t.databaseUrl,
              ABELE_BLOB_DIR: f.t.config.blobDir,
              ABELE_MASTER_KEY: 'ab'.repeat(32),
              ABELE_TOKEN_PEPPER: f.t.config.tokenPepper,
            },
            { log: (s) => lines.push(s), error: () => {} }
          )
        ).toBe(0)
        const recovery = new V2SyncClient(JSON.parse(lines[0]!).token)
        expect(JSON.stringify(await recovery.json('/trash'))).toContain(a.file_id)
        success(
          await recovery.json(
            '/files/' + a.file_id + '/restore',
            'POST',
            { deleted: true },
            { 'idempotency-key': randomUUID() }
          )
        )
        expect((await recovery.content(a.file_id)).toString()).toBe('a')
      } finally {
        await f.close()
      }
    })
    it('group self-deletion deletes only its current authorized members, including nested group tokens', async () => {
      const f = await tokenFixture(dialect)
      try {
        const root = success(await f.root.create('Index.md', 'index'))
        const member = success(
          await f.root.create('Member.md', '---\ngroups: ["[[Index]]"]\n---\nmember')
        )
        const keep = success(await f.root.create('Other.md', 'untouched'))
        const issued = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: root.file_id },
          label: 'My group',
        })
        const group = new V2SyncClient(issued.token)
        expect((await group.manifest()).items.map((i) => i.file_id)).toContain(member.file_id)
        const child = await group.json('/tokens', 'POST', {
          scope: { kind: 'group', id: member.file_id },
          label: 'Nested',
        })
        const key = randomUUID()
        const result = await group.json(
          '/connection/delete',
          'POST',
          {},
          { 'idempotency-key': key }
        )
        expect(result.files).toBe(2)
        expect(result.revoked_tokens).toEqual(
          expect.arrayContaining([issued.info.id, child.info.id])
        )
        expect(
          await group.json('/connection/delete', 'POST', {}, { 'idempotency-key': key })
        ).toEqual(result)
        expect((await f.root.content(keep.file_id)).toString()).toBe('untouched')
        expect(JSON.stringify(await f.root.json('/trash'))).toContain(member.file_id)
        success(
          await f.root.json(
            '/files/' + member.file_id + '/restore',
            'POST',
            { deleted: true },
            { 'idempotency-key': randomUUID() }
          )
        )
        expect((await f.root.content(member.file_id)).toString()).toContain('member')
      } finally {
        await f.close()
      }
    })
    it('read-only tokens cannot delete scopes, commit, upload or delegate write authority', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('Agents/a.md', 'hello'))
        const issued = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'folder', id: f.share.info.scope.id },
          label: 'Read only',
          read_only: true,
        })
        const reader = new V2SyncClient(issued.token)
        expect((await reader.manifest()).items.some((i) => i.file_id === file.file_id)).toBe(true)
        expect(
          (
            await reader.request(
              '/connection/delete',
              'POST',
              {},
              { 'idempotency-key': randomUUID() }
            )
          ).status
        ).toBe(403)
        expect(
          (
            await reader.request(
              '/commit',
              'POST',
              { ops: [{ op: 'delete', file_id: file.file_id, base_version_id: file.version_id }] },
              { 'idempotency-key': randomUUID() }
            )
          ).status
        ).toBe(403)
        expect(
          (await reader.request('/uploads/' + 'a'.repeat(64), 'PUT', Buffer.from('no'))).status
        ).toBe(403)
        const child = await reader.json('/tokens', 'POST', {
          scope: { kind: 'folder', id: f.share.info.scope.id },
          label: 'Child',
          read_only: false,
        })
        expect(child.info.read_only).toBe(true)
        expect(
          (
            await new V2SyncClient(child.token).request(
              '/connection/delete',
              'POST',
              {},
              { 'idempotency-key': randomUUID() }
            )
          ).status
        ).toBe(403)
        expect((await f.root.content(file.file_id)).toString()).toBe('hello')
      } finally {
        await f.close()
      }
    })
    it('rejects reused keys from other operations and requires proof of the deleting token secret', async () => {
      const f = await tokenFixture(dialect)
      try {
        const opKey = randomUUID()
        await f.guest.commit([{ op: 'mkdir', path: 'Agents/keep' }], opKey)
        expect(
          (await f.guest.request('/connection/delete', 'POST', {}, { 'idempotency-key': opKey }))
            .status
        ).toBe(422)
        const key = randomUUID()
        await f.guest.json('/connection/delete', 'POST', {}, { 'idempotency-key': key })
        const unknown = await fetch(f.t.address + '/v2/connection/delete', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + 'z'.repeat(43),
            'idempotency-key': key,
            'content-type': 'application/json',
          },
          body: '{}',
        })
        expect(unknown.status).toBe(401)
        expect(
          (await f.guest.request('/commit', 'POST', { ops: [] }, { 'idempotency-key': key })).status
        ).toBe(401)
        const another = await f.root.json(
          '/connection/delete',
          'POST',
          {},
          { 'idempotency-key': key }
        )
        expect(another.revoked_tokens).not.toContain(f.share.info.id)
        expect(
          await f.t.db
            .selectFrom('audit')
            .selectAll()
            .where('action', '=', 'connection.delete')
            .execute()
        ).toHaveLength(2)
      } finally {
        await f.close()
      }
    })
  })
