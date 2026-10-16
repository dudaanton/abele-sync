import { describe, expect, it } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import { sql } from 'kysely'
import { v2Server } from '../helpers/v2Server.js'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { createUser } from '../../src/access/tokens.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { runAdmin } from '../../src/admin-cli/index.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(dialect, () => {
    it('samples token use/address at most once per minute and trusts only configured client chains', async () => {
      let at = new Date('2030-01-01T12:00:00.000Z')
      const t = await v2Server(dialect, { now: () => at, trustProxy: true })
      try {
        const issued = await createUser(
          { db: t.db, pepper: t.config.tokenPepper },
          'Owner',
          t.address
        )
        const client = new V2SyncClient(issued.token)
        await sql.raw('create table activity_touch_probe (token_id text)').execute(t.db)
        if (dialect === 'pg') {
          await sql
            .raw(
              'create function probe_token_touch() returns trigger language plpgsql as $$ begin insert into activity_touch_probe values (new.id); return new; end $$'
            )
            .execute(t.db)
          await sql
            .raw(
              'create trigger probe_token_touch after update of last_used_at on access_tokens for each row execute function probe_token_touch()'
            )
            .execute(t.db)
        } else
          await sql
            .raw(
              'create trigger probe_token_touch after update of last_used_at on access_tokens begin insert into activity_touch_probe values (new.id); end'
            )
            .execute(t.db)
        const request = (ip: string) =>
          client.json('/connection', 'GET', undefined, { 'x-forwarded-for': ip })
        await request('203.0.113.10')
        let row = await t.db
          .selectFrom('access_tokens')
          .selectAll()
          .where('id', '=', issued.info.id)
          .executeTakeFirstOrThrow()
        expect(row.last_used_at).toBe(at.toISOString())
        expect(row.last_address).toBe('203.0.113.10')
        at = new Date('2030-01-01T12:00:59.000Z')
        await request('203.0.113.11')
        row = await t.db
          .selectFrom('access_tokens')
          .selectAll()
          .where('id', '=', issued.info.id)
          .executeTakeFirstOrThrow()
        expect(row.last_address).toBe('203.0.113.10')
        at = new Date('2030-01-01T12:01:00.000Z')
        await request('203.0.113.12')
        row = await t.db
          .selectFrom('access_tokens')
          .selectAll()
          .where('id', '=', issued.info.id)
          .executeTakeFirstOrThrow()
        expect(row.last_used_at).toBe(at.toISOString())
        expect(row.last_address).toBe('203.0.113.12')
        expect(
          (await sql<{ n: number }>`select count(*) as n from activity_touch_probe`.execute(t.db))
            .rows[0]!.n
        ).toBe(2)
        // A broken telemetry sink must not turn a valid credential into a failed read.
        await sql.raw('drop table activity_touch_probe').execute(t.db)
        at = new Date('2030-01-01T12:02:00.000Z')
        expect((await request('203.0.113.13')).status).toBe('active')
      } finally {
        await t.close()
      }
    })
    it('withholds an untrusted proxy or private peer address', async () => {
      const f = await tokenFixture(dialect)
      try {
        await f.guest.json('/connection', 'GET', undefined, { 'x-forwarded-for': '203.0.113.99' })
        const row = await f.t.db
          .selectFrom('access_tokens')
          .selectAll()
          .where('id', '=', f.share.info.id)
          .executeTakeFirstOrThrow()
        expect(row.last_address).toBeNull()
        expect(row.address_status).toBe('proxy')
      } finally {
        await f.close()
      }
    })
    it('counts successful transfers and new commits per token/day and exposes vault aggregates in the CLI', async () => {
      let clock = new Date('2030-01-02T12:00:00Z')
      const t = await v2Server(dialect, { now: () => clock })
      try {
        const issued = await createUser(
          { db: t.db, pepper: t.config.tokenPepper },
          'Owner',
          t.address
        )
        const root = new V2SyncClient(issued.token)
        const blob = await root.upload(Buffer.from('hello'))
        const op = { op: 'create' as const, path: 'a.md', ...blob, mtime: 1 }
        const key = randomUUID()
        const file = success((await root.commit([op], key)).results[0]!)
        await root.commit([op], key)
        await root.content(file.file_id)
        const partial = await root.request(
          '/files/' + file.file_id + '/content',
          'GET',
          undefined,
          { range: 'bytes=1-2' }
        )
        expect(await partial.text()).toBe('el')
        await root.request('/files/' + file.file_id + '/content', 'HEAD')
        const invalid = await root.request(
          '/files/' + file.file_id + '/content',
          'GET',
          undefined,
          { range: 'bytes=999-' }
        )
        expect(invalid.status).toBe(416)
        const shared = await root.share(issued.info.scope.id)
        await new V2SyncClient(shared.token).content(file.file_id)
        await expect
          .poll(async () =>
            t.db
              .selectFrom('activity_daily')
              .selectAll()
              .where('token_id', '=', issued.info.id)
              .executeTakeFirst()
          )
          .toMatchObject({
            day: '2030-01-02',
            uploaded_files: 1,
            uploaded_bytes: 5,
            downloaded_files: 2,
            downloaded_bytes: 7,
            commits: 1,
          })
        const env = {
          ABELE_DATABASE_URL: t.databaseUrl,
          ABELE_BLOB_DIR: t.config.blobDir,
          ABELE_MASTER_KEY: 'ab'.repeat(32),
          ABELE_TOKEN_PEPPER: t.config.tokenPepper,
        }
        const cli = async (...args: string[]) => {
          const lines: string[] = []
          expect(
            await runAdmin([...args, '--json'], env, { log: (s) => lines.push(s), error: () => {} })
          ).toBe(0)
          return JSON.parse(lines.join('\n'))
        }
        expect(
          (await cli('connections', 'list')).find((r: { id: string }) => r.id === issued.info.id)
            .activity_daily[0]
        ).toMatchObject({ commits: 1, uploaded_bytes: 5, downloaded_bytes: 7 })
        expect((await cli('connections', 'show', shared.info.id)).activity_daily[0]).toMatchObject({
          downloaded_files: 1,
          downloaded_bytes: 5,
        })
        expect((await cli('vaults', 'show', 'Owner')).activity_daily[0]).toMatchObject({
          uploaded_files: 1,
          downloaded_files: 3,
          downloaded_bytes: 12,
          commits: 1,
        })
        expect(
          (await cli('activity', '--connection', issued.info.id, '--since', '2030-01-02T00:00:00Z'))
            .daily[0]
        ).toMatchObject({ commits: 1, uploaded_bytes: 5 })
        await Promise.all(Array.from({ length: 8 }, () => root.upload(Buffer.from('abc'))))
        const data = Buffer.from('abcdef')
        const sha = createHash('sha256').update(data).digest('hex')
        const begun = await root.json('/uploads/' + sha + '/begin', 'POST', { size: data.length })
        expect(
          (await root.request('/uploads/' + sha + '/' + begun.upload_id + '/0', 'PUT', data)).status
        ).toBe(204)
        await root.json('/uploads/' + sha + '/' + begun.upload_id + '/complete', 'POST')
        const bad = await root.request('/uploads/' + 'a'.repeat(64), 'PUT', Buffer.from('bad'))
        expect(bad.status).toBe(400)
        expect((await bad.json()).error.code).toBe('hash_mismatch')
        await expect
          .poll(async () =>
            t.db
              .selectFrom('activity_daily')
              .selectAll()
              .where('token_id', '=', issued.info.id)
              .where('day', '=', '2030-01-02')
              .executeTakeFirst()
          )
          .toMatchObject({ uploaded_files: 10, uploaded_bytes: 35, commits: 1 })
        clock = new Date('2030-01-03T00:00:01Z')
        await root.upload(Buffer.from('today'))
        await expect
          .poll(async () =>
            t.db
              .selectFrom('activity_daily')
              .selectAll()
              .where('token_id', '=', issued.info.id)
              .where('day', '=', '2030-01-03')
              .executeTakeFirst()
          )
          .toMatchObject({ uploaded_files: 1, uploaded_bytes: 5, commits: 0 })
      } finally {
        await t.close()
      }
    })
  })
