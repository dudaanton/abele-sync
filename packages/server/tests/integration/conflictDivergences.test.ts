import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { api } from '../helpers/client.js'
import { conflictCopyName } from '../../src/merge/index.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetainedEngineRetention as runRetention } from '../helpers/retainedRetention.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`conflict divergences (${dialect})`, () => {
    it('replays exact conflict receipts under the vault fence but refuses materialized stale copy pointers', async () => {
      const t = await buildTestApp({ dialect })
      try {
        const account = (await t.account()).accountToken
        const vault = (await t.vault(account)).vaultId
        const token = (await t.device(account, vault)).deviceToken
        for (const text of ['base\n', 'head\n', 'incoming\n', 'edited\n'])
          await putBlob(t.app, token, text)
        const made = (await commit(t.app, token, vault, [create('N.md', 'base\n')])).results[0]
        const op = {
          op: 'modify',
          file_id: made.file_id,
          base_version_id: made.version_id,
          sha: shaOf('incoming\n'),
          size: 9,
          mtime: 5,
        }
        await commit(t.app, token, vault, [{ ...op, sha: shaOf('head\n'), size: 5 }])
        const request = () =>
          api(t.app, token).post(
            `/v1/vaults/${vault}/commit`,
            { ops: [op] },
            { 'idempotency-key': 'divergence' }
          )
        const first = await request()
        expect(first.status).toBe(200)
        expect((await request()).body).toEqual(first.body)
        const copy = first.body.results[0]
        await commit(t.app, token, vault, [
          {
            op: 'modify',
            file_id: copy.conflict_file_id,
            base_version_id: copy.conflict_version_id,
            sha: shaOf('edited\n'),
            size: 7,
            mtime: 6,
          },
        ])
        expect((await request()).status).toBe(404)
        expect(await t.db.selectFrom('files').select('id').execute()).toHaveLength(2)
        expect(
          await t.db.selectFrom('versions').select('id').where('op', '=', 'conflict').execute()
        ).toHaveLength(1)
      } finally {
        await t.close()
      }
    })
    it('suppresses identical stale Markdown edits in both conflict modes, even after base pruning', async () => {
      const t = await buildTestApp({ dialect })
      try {
        const account = (await t.account()).accountToken
        const vault = (await t.vault(account)).vaultId
        const token = (await t.device(account, vault)).deviceToken
        for (const text of ['base\n', 'identical\n']) await putBlob(t.app, token, text)
        const first = (await commit(t.app, token, vault, [create('N.md', 'base\n')])).results[0]
        const op = {
          op: 'modify',
          file_id: first.file_id,
          base_version_id: first.version_id,
          sha: shaOf('identical\n'),
          size: 10,
          mtime: 5,
        }
        const head = (await commit(t.app, token, vault, [op])).results[0]
        for (const conflict of ['merge', 'conflict-file']) {
          await api(t.app, token).patch(`/v1/vaults/${vault}/settings`, { conflict })
          expect((await commit(t.app, token, vault, [op])).results[0]).toMatchObject({
            status: 'applied',
            version_id: head.version_id,
          })
        }
        await t.db.deleteFrom('versions').where('id', '=', first.version_id).execute()
        expect((await commit(t.app, token, vault, [op])).results[0]).toMatchObject({
          status: 'applied',
          version_id: head.version_id,
        })
        expect(await t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
        expect(await t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
        expect(await t.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(0)
      } finally {
        await t.close()
      }
    })
    it('allocates an opaque collision name, distinguishes bases and creates, and retains identities without pinning payloads through GC', async () => {
      let clock = new Date('2030-01-01T00:00:00.000Z')
      const t = await buildTestApp({ dialect, now: () => clock })
      try {
        const account = (await t.account()).accountToken
        const vault = (await t.vault(account)).vaultId
        const token = (await t.device(account, vault, 'phone')).deviceToken
        for (const text of [
          'base\n',
          'head\n',
          'incoming\n',
          'advance\n',
          'occupied\n',
          'edited\n',
        ])
          await putBlob(t.app, token, text)
        const original = (await commit(t.app, token, vault, [create('N.md', 'base\n')])).results[0]
        const modify = (text: string, version = original.version_id, file = original.file_id) => ({
          op: 'modify',
          file_id: file,
          base_version_id: version,
          sha: shaOf(text),
          size: text.length,
          mtime: 5,
        })
        const head = (await commit(t.app, token, vault, [modify('head\n')])).results[0]
        const preferred = conflictCopyName('N.md', 'phone', clock)
        await commit(t.app, token, vault, [create(preferred, 'occupied\n')])
        const first = (await commit(t.app, token, vault, [modify('incoming\n')])).results[0]
        expect(first).toMatchObject({ status: 'conflict', sha: shaOf('head\n') })
        expect(first.conflict_path).not.toBe(preferred)
        expect(first.conflict_path).toMatch(/203001010000 [a-f0-9]{12}\)\.md$/)
        const advanced = (await commit(t.app, token, vault, [modify('advance\n', head.version_id)]))
          .results[0]
        const second = (await commit(t.app, token, vault, [modify('incoming\n', head.version_id)]))
          .results[0]
        expect(second.status).toBe('conflict')
        expect(second.conflict_file_id).not.toBe(first.conflict_file_id)
        const colliding = create('N.md', 'incoming\n')
        const third = (await commit(t.app, token, vault, [colliding])).results[0]
        expect(third.status).toBe('conflict')
        expect(
          new Set([first.conflict_file_id, second.conflict_file_id, third.conflict_file_id]).size
        ).toBe(3)
        expect((await commit(t.app, token, vault, [colliding])).results[0].conflict_file_id).toBe(
          third.conflict_file_id
        )
        const renamed = (
          await commit(t.app, token, vault, [
            {
              op: 'move',
              file_id: original.file_id,
              base_version_id: advanced.version_id,
              to_path: 'Renamed.md',
            },
          ])
        ).results[0]
        const createReplay = (await commit(t.app, token, vault, [colliding])).results[0]
        expect(createReplay).toMatchObject({
          status: 'conflict',
          file_id: original.file_id,
          version_id: renamed.version_id,
          path: 'Renamed.md',
          conflict_file_id: third.conflict_file_id,
        })
        expect(
          await t.db.selectFrom('files').select('id').where('path', '=', 'N.md').execute()
        ).toEqual([])
        for (const copy of [first, second, third])
          await commit(t.app, token, vault, [
            modify('edited\n', copy.conflict_version_id, copy.conflict_file_id),
          ])
        const refsBefore = await t.db.selectFrom('blobs').selectAll().orderBy('sha').execute()
        const versionsBefore = await t.db.selectFrom('versions').select('id').execute()
        expect(
          (await commit(t.app, token, vault, [modify('incoming\n')])).results[0]
        ).toMatchObject({ status: 'rejected', code: 'not_found' })
        expect(await t.db.selectFrom('blobs').selectAll().orderBy('sha').execute()).toEqual(
          refsBefore
        )
        expect(await t.db.selectFrom('versions').select('id').execute()).toEqual(versionsBefore)
        clock = new Date('2032-01-01T00:00:00.000Z')
        const gc = await runRetention({
          ...t,
          dialect,
          now: () => clock,
          idempotencyTtlMs: 1,
          uploads: createUploadManager({
            ...t,
            now: () => clock,
            config: loadConfig({
              ABELE_MASTER_KEY: 'ab'.repeat(32),
              ABELE_TOKEN_PEPPER: 'test',
              ABELE_BLOB_DIR: t.store.dir,
            }),
          }),
        })
        expect(gc.versions_removed).toBeGreaterThan(0)
        expect(await t.store.has(shaOf('incoming\n'))).toBe(false)
        expect(
          await t.db
            .selectFrom('versions')
            .select('id')
            .where('id', '=', original.version_id)
            .execute()
        ).toEqual([])
        await putBlob(t.app, token, 'incoming\n')
        expect(
          (await commit(t.app, token, vault, [modify('incoming\n')])).results[0]
        ).toMatchObject({ status: 'rejected', code: 'not_found' })
        expect(await t.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(3)
        const usage = (await api(t.app, token).get(`/v1/vaults/${vault}/usage`)).body
        expect(usage.live_bytes).toBe(
          'advance\n'.length + 'occupied\n'.length + 3 * 'edited\n'.length
        )
      } finally {
        await t.close()
      }
    }, 30_000)
    it('keeps complete variants separate and deduplicates devices through head advancement, copy edits and deletion', async () => {
      const t = await buildTestApp({ dialect })
      try {
        const account = (await t.account()).accountToken
        const vault = (await t.vault(account)).vaultId
        const laptop = (await t.device(account, vault, 'laptop')).deviceToken
        const phone = (await t.device(account, vault, 'phone')).deviceToken
        const base = 'the quick brown fox\nunchanged\n'
        const headText = 'the QUICK brown fox\nunchanged\n'
        const incoming = 'the quick brown FOX\nother incoming edit\n'
        for (const text of [base, headText, incoming]) await putBlob(t.app, laptop, text)
        const original = (await commit(t.app, laptop, vault, [create('Note.md', base)])).results[0]
        const modify = (text: string, version = original.version_id) => ({
          op: 'modify',
          file_id: original.file_id,
          base_version_id: version,
          sha: shaOf(text),
          size: Buffer.byteLength(text),
          mtime: 5,
        })
        const head = (await commit(t.app, laptop, vault, [modify(headText)])).results[0]
        const first = (await commit(t.app, phone, vault, [modify(incoming)])).results[0]
        expect(first).toMatchObject({
          status: 'conflict',
          version_id: head.version_id,
          sha: shaOf(headText),
        })
        const duplicates = await Promise.all(
          [laptop, phone].map(
            async (token) => (await commit(t.app, token, vault, [modify(incoming)])).results[0]
          )
        )
        for (const duplicate of duplicates) expect(duplicate).toEqual(first)
        const moved = (
          await commit(t.app, laptop, vault, [
            {
              op: 'move',
              file_id: original.file_id,
              base_version_id: head.version_id,
              to_path: 'Moved.md',
            },
          ])
        ).results[0]
        const replay = (await commit(t.app, phone, vault, [modify(incoming)])).results[0]
        expect(replay).toMatchObject({
          status: 'conflict',
          path: 'Moved.md',
          version_id: moved.version_id,
          conflict_file_id: first.conflict_file_id,
        })
        await putBlob(t.app, laptop, 'copy edited\n')
        const edited = (
          await commit(t.app, laptop, vault, [
            {
              op: 'modify',
              file_id: first.conflict_file_id,
              base_version_id: first.conflict_version_id,
              sha: shaOf('copy edited\n'),
              size: 12,
              mtime: 6,
            },
          ])
        ).results[0]
        expect((await commit(t.app, phone, vault, [modify(incoming)])).results[0]).toMatchObject({
          status: 'rejected',
          code: 'not_found',
        })
        await commit(t.app, laptop, vault, [
          { op: 'delete', file_id: first.conflict_file_id, base_version_id: edited.version_id },
        ])
        expect((await commit(t.app, phone, vault, [modify(incoming)])).results[0]).toMatchObject({
          status: 'rejected',
          code: 'not_found',
        })
        expect(await t.db.selectFrom('files').select('id').execute()).toHaveLength(2)
        expect(
          await t.db.selectFrom('versions').select('id').where('op', '=', 'conflict').execute()
        ).toHaveLength(1)
        expect(await t.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(1)
      } finally {
        await t.close()
      }
    })
  })
