import { describe, expect, it, vi } from 'vitest'
import { sql, type KyselyPlugin } from 'kysely'
import { disableAccountWithFence } from '../../src/auth/accountFence.js'
import { revokeDevice } from '../../src/auth/devices.js'
import { updateFolderKey } from '../../src/auth/folderManagement.js'
import { createDb } from '../../src/db/connect.js'
import { commit as commitDirect } from '../../src/oplog/commit.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { verifyPersonalFile, verifyScopedFile } from '../../src/vault/externalFiles.js'
import { runRetention } from '../../src/history/retention.js'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

const gate = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `external verification serialization (${dialect})`,
    () => {
      async function fixture() {
        const f = await scopedFixture(dialect)
        await putBlob(f.t.app, f.device.deviceToken, 'original')
        let file = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/a.bin', 'original')])
        ).results[0]!
        const historical = file.version_id
        await putBlob(f.t.app, f.device.deviceToken, 'current')
        file = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            {
              op: 'modify',
              file_id: file.file_id,
              base_version_id: historical,
              sha: shaOf('current'),
              size: 7,
              mtime: 2,
            },
          ])
        ).results[0]!
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const reader = await f.issue('reader', 'reader')
        const other = dialect === 'pg' ? createDb(f.t.databaseUrl!) : null
        const bound = { ...f.deps, db: other?.db ?? f.t.db }
        const input = {
          version_id: file.version_id,
          path: file.path,
          sha: shaOf('current'),
          size: 7,
        }
        const verify = (mode: 'personal' | 'scoped') =>
          mode === 'personal'
            ? verifyPersonalFile(f.deps, f.device.deviceToken, f.vault, file.file_id, input)
            : verifyScopedFile(f.deps, reader.key_token, f.vault, f.grant.id, file.file_id, input)
        return {
          ...f,
          file,
          historical,
          reader,
          bound,
          input,
          verify,
          close: async () => {
            await other?.close()
            await f.close()
          },
        }
      }
      for (const mode of ['personal', 'scoped'] as const) {
        it(`BUG: ${mode} rechecks account authority after a long content check`, async () => {
          const f = await fixture()
          try {
            const original = f.t.store.verify.bind(f.t.store)
            let contentChecked = false
            const queries = new Set<object>()
            const plugin: KyselyPlugin = {
              transformQuery(args) {
                const raw = JSON.stringify(args.node)
                if (
                  args.node.kind === 'SelectQueryNode' &&
                  raw.includes('accounts') &&
                  raw.includes('disabled_at')
                )
                  queries.add(args.queryId)
                return args.node
              },
              async transformResult(args) {
                // Inject lost authority into the actual final read; a missing recheck
                // would incorrectly return success. Concurrent real disable is tested below.
                if (contentChecked && queries.has(args.queryId))
                  return {
                    ...args.result,
                    rows: args.result.rows.map((row) => ({
                      ...(row as Record<string, unknown>),
                      disabled_at: f.deps.now().toISOString(),
                    })),
                  }
                return args.result
              },
            }
            vi.spyOn(f.t.store, 'verify').mockImplementationOnce(async (sha) => {
              const result = await original(sha)
              contentChecked = true
              return result
            })
            const deps = { ...f.deps, db: f.t.db.withPlugin(plugin) }
            await expect(
              mode === 'personal'
                ? verifyPersonalFile(deps, f.device.deviceToken, f.vault, f.file.file_id, f.input)
                : verifyScopedFile(
                    deps,
                    f.reader.key_token,
                    f.vault,
                    f.grant.id,
                    f.file.file_id,
                    f.input
                  )
            ).rejects.toMatchObject({ code: 'unauthorized' })
          } finally {
            await f.close()
          }
        })
        for (const mutation of [
          'revoke',
          'account-disable',
          'modify',
          'delete',
          'retention',
        ] as const)
          it(`BUG: ${mode} has a serialized result when ${mutation} begins during blob verification`, async () => {
            const f = await fixture(),
              entered = gate(),
              release = gate()
            let checking: Promise<unknown> | undefined, changing: Promise<unknown> | undefined
            try {
              if (mutation === 'retention') {
                const row = await f.t.db
                  .selectFrom('vaults')
                  .select('settings')
                  .where('id', '=', f.vault)
                  .executeTakeFirstOrThrow()
                await f.t.db
                  .updateTable('vaults')
                  .set({
                    settings: JSON.stringify({
                      ...JSON.parse(row.settings),
                      retention: { notes_days: 0, attachments_days: 0, settings_days: 0 },
                    }),
                  })
                  .where('id', '=', f.vault)
                  .execute()
              }
              const original = f.t.store.verify.bind(f.t.store)
              vi.spyOn(f.t.store, 'verify').mockImplementationOnce(async (sha) => {
                entered.release()
                await release.promise
                return original(sha)
              })
              checking = f.verify(mode)
              // Do not hang if regression causes a premature refusal instead of entering the blob check.
              await Promise.race([
                entered.promise,
                checking.then(() => {
                  throw new Error('verification skipped content')
                }),
              ])
              if (mutation === 'revoke')
                changing =
                  mode === 'personal'
                    ? revokeDevice(f.bound, f.owner.accountId, f.device.deviceId)
                    : updateFolderKey(
                        f.bound,
                        f.owner.accountToken,
                        f.vault,
                        f.grant.id,
                        f.reader.key_id,
                        { expected_revision: 0, revoke: true }
                      )
              else if (mutation === 'account-disable')
                changing = disableAccountWithFence(
                  f.bound,
                  f.owner.accountId,
                  f.deps.now().toISOString()
                )
              else if (mutation === 'retention') {
                changing = (async () => {
                  const config = loadConfig({
                    ABELE_MASTER_KEY: 'ab'.repeat(32),
                    ABELE_TOKEN_PEPPER: 'test',
                    ABELE_BLOB_DIR: f.t.store.dir,
                  })
                  return runRetention({
                    ...f.bound,
                    uploads: createUploadManager({ ...f.bound, config }),
                    idempotencyTtlMs: 86400000,
                    now: () => new Date('2030-01-01T02:00:00.000Z'),
                  })
                })()
              } else
                changing = commitDirect(
                  f.bound,
                  f.vault,
                  { kind: 'device', id: f.device.deviceId, name: 'owner' },
                  mutation === 'delete'
                    ? [
                        {
                          op: 'delete',
                          file_id: f.file.file_id,
                          base_version_id: f.file.version_id,
                        },
                      ]
                    : [
                        {
                          op: 'modify',
                          file_id: f.file.file_id,
                          base_version_id: f.file.version_id,
                          sha: f.input.sha,
                          size: f.input.size,
                          mtime: 3,
                        },
                      ]
                )
              let changed = false
              changing.then(
                () => {
                  changed = true
                },
                () => {
                  changed = true
                }
              )
              if (dialect === 'pg') {
                let waiting = false
                for (let n = 0; n < 100; n++) {
                  const rows =
                    await sql`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'`.execute(
                      f.bound.db
                    )
                  if (rows.rows.length) {
                    waiting = true
                    break
                  }
                  await new Promise((r) => setTimeout(r, 5))
                }
                expect(waiting).toBe(true)
              } else await new Promise((r) => setTimeout(r, 20))
              expect(changed).toBe(false)
              release.release()
              expect(await checking).toEqual({
                verified: true,
                file_id: f.file.file_id,
                ...f.input,
              })
              await changing
              if (mutation === 'retention') {
                expect(await f.t.store.has(f.input.sha)).toBe(true)
                expect(
                  await f.t.db
                    .selectFrom('versions')
                    .select('id')
                    .where('id', '=', f.historical)
                    .execute()
                ).toEqual([])
                expect(await f.verify(mode)).toMatchObject({ verified: true })
              } else
                await expect(f.verify(mode)).rejects.toMatchObject({
                  code:
                    mutation === 'modify' || mutation === 'delete' ? 'not_found' : 'unauthorized',
                })
            } finally {
              release.release()
              await Promise.allSettled([checking, changing].filter(Boolean))
              await f.close()
            }
          })
      }
      for (const expiry of ['key', 'grant'] as const)
        it(`BUG: refuses scoped ${expiry} expiry during the content read`, async () => {
          const f = await fixture()
          try {
            if (expiry === 'grant')
              await f.t.db
                .updateTable('scope_grants')
                .set({ expires_at: '2030-01-01T00:01:00.000Z' })
                .where('id', '=', f.grant.id)
                .execute()
            const original = f.t.store.verify.bind(f.t.store)
            vi.spyOn(f.t.store, 'verify').mockImplementationOnce(async (sha) => {
              const result = await original(sha)
              f.setClock(expiry === 'key' ? '2030-01-02T00:00:00.000Z' : '2030-01-01T00:01:00.000Z')
              return result
            })
            await expect(f.verify('scoped')).rejects.toMatchObject({ code: 'unauthorized' })
          } finally {
            await f.close()
          }
        })
    }
  )
