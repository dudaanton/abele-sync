import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../src/db/schema.js'
import { restoreDeleted } from '../../src/history/trash.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/**
 * A single-file trash restore races another device that restores the same file and edits it.
 * Which version comes back has to be chosen under the vault's lock, as the bulk route does: a
 * choice made before the lock can be a trashed version that is no longer in the trash by the
 * time it is written, and writing it would put the old bytes over the other device's edit.
 */

/**
 * `db`, except that the first read answered outside a transaction runs `race` before its
 * answer is handed back — the gap between choosing and writing, stood in on purpose.
 */
function racingDb(db: Kysely<Database>, race: () => Promise<void>): Kysely<Database> {
  let raced = false
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver) as unknown
        if (typeof value !== 'function') return value
        if (property === 'executeTakeFirst' || property === 'execute') {
          return async (...args: unknown[]) => {
            const answer = await (value as (...a: unknown[]) => Promise<unknown>).apply(
              object,
              args
            )
            if (!raced) {
              raced = true
              await race()
            }
            return answer
          }
        }
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(object, args)
          return typeof result === 'object' && result !== null && 'executeTakeFirst' in result
            ? wrap(result)
            : result
        }
      },
    })
  return new Proxy(db, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown
      if (property !== 'selectFrom' || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(object) : value
      }
      return (...args: unknown[]) =>
        wrap((value as (...a: unknown[]) => object).apply(object, args))
    },
  })
}

describe('single trash restore', () => {
  let t: TestApp
  beforeEach(async () => {
    t = await buildTestApp()
  })
  afterEach(async () => {
    await t.close()
  })

  it('never writes a trashed version over a file another device restored and edited meanwhile', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const me = await t.device(accountToken, vaultId, 'me')
    const other = await t.device(accountToken, vaultId, 'other')
    await putBlob(t.app, me.deviceToken, 'old\n')
    const made = (await commit(t.app, me.deviceToken, vaultId, [create('Note.md', 'old\n')]))
      .results[0]
    const gone = (
      await commit(t.app, me.deviceToken, vaultId, [
        { op: 'delete', file_id: made.file_id, base_version_id: made.version_id },
      ])
    ).results[0]
    expect(gone.status).toBe('applied')

    // The other device brings the file back and edits it, in the gap.
    const race = async (): Promise<void> => {
      const back = await api(t.app, other.deviceToken).post(
        `/v1/vaults/${vaultId}/trash/${made.file_id}/restore`,
        {}
      )
      expect(back.body.status).toBe('applied')
      await putBlob(t.app, other.deviceToken, 'edited\n')
      await commit(t.app, other.deviceToken, vaultId, [
        {
          op: 'modify',
          file_id: made.file_id,
          base_version_id: back.body.version_id,
          sha: shaOf('edited\n'),
          size: 7,
          mtime: 5,
        },
      ])
    }

    let raced = false
    const result = await restoreDeleted(
      {
        db: racingDb(t.db, async () => {
          raced = true
          await race()
        }),
        dialect: 'sqlite',
        store: t.store,
        hub: t.hub,
      },
      vaultId,
      { kind: 'device', id: me.deviceId, name: 'me' },
      made.file_id
    )
    const head = await t.db
      .selectFrom('files')
      .innerJoin('versions', 'versions.id', 'files.head_version_id')
      .select(['versions.blob_sha as sha', 'files.deleted_at as deleted_at'])
      .where('files.id', '=', made.file_id)
      .executeTakeFirstOrThrow()
    expect(head.deleted_at).toBeNull()
    if (raced) {
      // Chosen before the lock: whatever came of it, the other device's edit is the head.
      expect(head.sha).toBe(shaOf('edited\n'))
      expect(result).toMatchObject({ status: 'rejected', code: 'not_found' })
    }
    // Chosen under the lock, there is no gap to race in: nothing was read outside it.
    expect(raced).toBe(false)
    expect(result.status).toBe('applied')
  })
})
