import type { CommitOp } from '@abele/sync-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetention } from '../../src/history/retention.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'

const DAY = 24 * 60 * 60 * 1000
const BASE = Date.parse('2026-01-01T00:00:00.000Z')
interface Written {
  file_id: string
  version_id: string
  path: string
}

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `immutable version retention (${dialect})`,
    () => {
      let t: TestApp
      let token: string
      let vault: string
      let clock: Date
      const day = (n: number) => {
        clock = new Date(BASE + n * DAY)
      }
      const client = () => api(t.app, token)
      const settings = (patch: object) => client().patch(`/v1/vaults/${vault}/settings`, patch)
      const rows = (file: Written) =>
        t.db
          .selectFrom('versions')
          .selectAll()
          .where('file_id', '=', file.file_id)
          .orderBy('no')
          .execute()
      const ids = async (file: Written) => (await rows(file)).map((v) => v.id)
      const one = async (op: CommitOp): Promise<Written> => {
        const response = await commit(t.app, token, vault, [op])
        expect(response.results[0].status).toBe('applied')
        return response.results[0] as Written
      }
      const write = async (path: string, text: string) => {
        await putBlob(t.app, token, text)
        return one(create(path, text, clock.getTime()))
      }
      const modify = async (file: Written, text: string) => {
        await putBlob(t.app, token, text)
        return one({
          op: 'modify',
          file_id: file.file_id,
          base_version_id: file.version_id,
          sha: shaOf(text),
          size: Buffer.byteLength(text),
          mtime: clock.getTime(),
        })
      }
      const move = (file: Written, path: string) =>
        one({ op: 'move', file_id: file.file_id, base_version_id: file.version_id, to_path: path })
      const gc = () =>
        runRetention({
          db: t.db,
          dialect,
          store: t.store,
          now: () => clock,
          idempotencyTtlMs: DAY,
          uploads: createUploadManager({
            db: t.db,
            store: t.store,
            now: () => clock,
            config: loadConfig({
              ABELE_MASTER_KEY: 'ab'.repeat(32),
              ABELE_TOKEN_PEPPER: 'test',
              ABELE_BLOB_DIR: t.store.dir,
            }),
          }),
        })

      // PG fixtures create and fully migrate a fresh schema, authenticate with scrypt,
      // then DROP SCHEMA CASCADE on close, against the disposable server's single CPU.
      // Allow load headroom for that work, matching the test body's 30-second budget;
      // these retention checks are not fixture-speed assertions. SQLite keeps its default.
      const fixtureTimeout = dialect === 'pg' ? 30_000 : 10_000
      beforeEach(async () => {
        day(0)
        t = await buildTestApp({ dialect, now: () => clock })
        const { accountToken } = await t.account()
        vault = (await t.vault(accountToken)).vaultId
        token = (await t.device(accountToken, vault)).deviceToken
      }, fixtureTimeout)
      afterEach(async () => {
        await t.close()
      }, fixtureTimeout)

      for (const [path, age, window] of [
        ['Archive.md', 30, 365],
        ['Sketch.canvas', 30, 365],
        ['.obsidian/app.json', 20, 30],
      ] as const) {
        it(`keeps the original ${path} after a device overwrites it and renames it to an attachment`, async () => {
          const original = await write(path, 'original bytes')
          day(age)
          const edited = await modify(original, 'replacement bytes')
          await move(edited, 'Archive.bin')
          expect((await gc()).versions_removed).toBe(0)
          expect(await ids(original)).toContain(original.version_id)
          const historical = await client().get(
            `/v1/vaults/${vault}/files/${original.file_id}/versions/${original.version_id}`
          )
          expect(historical.status).toBe(200)
          expect(historical.raw).toBe('original bytes')
          // It is the original window, not indefinite protection or a fresh timestamp.
          day(window + 1)
          await gc()
          expect(await ids(original)).not.toContain(original.version_id)
          expect(await t.store.has(shaOf('original bytes'))).toBe(false)
        })
      }

      it('keeps note history through rename, delete and a trash restore', async () => {
        const original = await write('Archive.md', 'original bytes')
        day(30)
        const moved = await move(await modify(original, 'replacement bytes'), 'Archive.bin')
        await one({ op: 'delete', file_id: moved.file_id, base_version_id: moved.version_id })
        const restored = await client().post(`/v1/vaults/${vault}/trash/${moved.file_id}/restore`)
        expect(restored.status).toBe(200)
        expect(restored.body).toMatchObject({ status: 'applied', path: 'Archive.bin' })
        await gc()
        expect(await ids(original)).toContain(original.version_id)
        expect(await t.store.has(shaOf('original bytes'))).toBe(true)
      })

      it('keeps earlier note versions when version restore writes at the new attachment path', async () => {
        const original = await write('Archive.md', 'original bytes')
        const second = await modify(original, 'second note bytes')
        day(30)
        await move(await modify(second, 'replacement bytes'), 'Archive.bin')
        const restored = await client().post(
          `/v1/vaults/${vault}/files/${original.file_id}/restore`,
          { version_id: original.version_id }
        )
        expect(restored.status).toBe(200)
        expect(restored.body).toMatchObject({ status: 'applied', path: 'Archive.bin' })
        await gc()
        expect(await ids(original)).toContain(second.version_id)
        expect(await t.store.has(shaOf('second note bytes'))).toBe(true)
      })

      it('does not shorten earlier note history when scripts_folder reclassifies the file', async () => {
        const original = await write('Archive.md', 'original bytes')
        day(30)
        await move(await modify(original, 'replacement bytes'), 'Scripts/archive.js')
        expect((await settings({ scripts_folder: 'Automation' })).status).toBe(200)
        const file = await t.db
          .selectFrom('files')
          .select('kind')
          .where('id', '=', original.file_id)
          .executeTakeFirstOrThrow()
        expect(file.kind).toBe('attachment')
        await gc()
        expect(await ids(original)).toContain(original.version_id)
        expect(await t.store.has(shaOf('original bytes'))).toBe(true)
      })

      it('freezes script and attachment version classes while scripts_folder and live kinds change', async () => {
        // Scripts already share attachments_days; changing that mapping is not part of this fix.
        expect(
          (await settings({ retention: { attachments_days: 90 }, account_password: TEST_PASSWORD }))
            .status
        ).toBe(200)
        const oldScript = await write('Scripts/sample.js', 'old script')
        const newScript = await write('Automation/sample.js', 'new script')
        expect((await rows(oldScript))[0]).toMatchObject({ retention_class: 'attachments' })
        expect((await rows(newScript))[0]).toMatchObject({ retention_class: 'attachments' })
        day(30)
        await modify(oldScript, 'edited old script')
        await modify(newScript, 'edited new script')
        expect((await settings({ scripts_folder: 'Automation' })).status).toBe(200)
        await gc()
        expect(await ids(oldScript)).toContain(oldScript.version_id)
        expect(await ids(newScript)).toContain(newScript.version_id)
        for (const file of [oldScript, newScript]) {
          expect(
            (await rows(file)).every(
              (v) => 'retention_class' in v && v.retention_class === 'attachments'
            )
          ).toBe(true)
        }
        day(91)
        await gc()
        expect(await ids(oldScript)).not.toContain(oldScript.version_id)
        expect(await ids(newScript)).not.toContain(newScript.version_id)
      })

      it('keeps a conflict copy original under its own note window after overwrite and rename', async () => {
        expect((await settings({ conflict: 'conflict-file' })).status).toBe(200)
        await write('Archive.md', 'head bytes')
        await putBlob(t.app, token, 'conflicting bytes')
        const response = await commit(t.app, token, vault, [
          create('Archive.md', 'conflicting bytes'),
        ])
        const result = response.results[0]
        expect(result.status).toBe('conflict')
        const copy: Written = {
          file_id: result.conflict_file_id,
          version_id: result.conflict_version_id,
          path: result.conflict_path,
        }
        day(30)
        await move(await modify(copy, 'replacement bytes'), 'Copy.bin')
        await gc()
        expect(await ids(copy)).toContain(copy.version_id)
        expect(await t.store.has(shaOf('conflicting bytes'))).toBe(true)
      })

      it('does not turn attachment history into note history after a rename in the other direction', async () => {
        const original = await write('Picture.bin', 'old attachment')
        const edited = await modify(original, 'new attachment')
        day(30)
        await move(edited, 'Picture.md')
        await gc()
        expect(await ids(original)).not.toContain(original.version_id)
        expect(await t.store.has(shaOf('old attachment'))).toBe(false)
      })

      it('keeps a version with unknown retention provenance instead of borrowing the live kind', async () => {
        const original = await write('Picture.bin', 'old attachment')
        await modify(original, 'new attachment')
        await t.db
          .updateTable('versions')
          .set({ retention_class: null })
          .where('id', '=', original.version_id)
          .execute()
        day(400)
        expect((await gc()).versions_removed).toBe(0)
        expect(await ids(original)).toContain(original.version_id)
        expect(await t.store.has(shaOf('old attachment'))).toBe(true)
      })

      it('still applies a password-confirmed retention decrease to versions of that class', async () => {
        const original = await write('Archive.md', 'original bytes')
        day(30)
        await move(await modify(original, 'replacement bytes'), 'Archive.bin')
        await gc()
        expect(await ids(original)).toContain(original.version_id)
        const patch = { retention: { notes_days: 0 } }
        expect((await settings(patch)).status).toBe(403)
        expect((await settings({ ...patch, account_password: TEST_PASSWORD })).status).toBe(200)
        await gc()
        expect(await ids(original)).not.toContain(original.version_id)
      })
    }
  )
}
