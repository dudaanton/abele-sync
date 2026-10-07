import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectUnreferenced } from '../../src/blobs/pending.js'
import { addRef } from '../../src/blobs/refs.js'
import type { BlobStore } from '../../src/blobs/store.js'
import type { Dialect } from '../../src/db/connect.js'
import { create, putBlob, shaOf } from '../helpers/ops.js'
import { api } from '../helpers/client.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/**
 * A commit naming bytes no row stands for yet — a merge result it has just stored — races the
 * sweep that removes such bytes. Whatever the order, a `blobs` row the commit keeps must name
 * bytes that are still there.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function refRace(dialect: Dialect): void {
  let t: TestApp
  beforeEach(async () => {
    t = await buildTestApp({ dialect })
  })
  afterEach(async () => {
    await t.close()
  })

  it('rejects a reference when a rolled-back GC restored a zero-ref row without bytes', async () => {
    const bytes = Buffer.from('gc was rolled back after deleting bytes')
    const sha = shaOf(bytes)
    const at = new Date().toISOString()
    await t.db
      .insertInto('blobs')
      .values({
        sha,
        size: bytes.length,
        refs: 0,
        storage_ref: t.store.pathFor(sha),
        created_at: at,
        last_referenced_at: at,
      })
      .execute()
    await expect(
      t.db.transaction().execute((trx) => addRef(trx, t.store, sha, bytes.length, at))
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(
      await t.db.selectFrom('blobs').select('refs').where('sha', '=', sha).executeTakeFirst()
    ).toEqual({ refs: 0 })
  })

  it('rolls back an authorized commit when GC deletes bytes after the preflight check', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const bytes = 'authorized upload awaiting GC'
    const sha = await putBlob(t.app, deviceToken, bytes)
    const at = new Date().toISOString()
    await t.db
      .insertInto('blobs')
      .values({
        sha,
        size: bytes.length,
        refs: 0,
        storage_ref: t.store.pathFor(sha),
        created_at: at,
        last_referenced_at: at,
      })
      .execute()
    const originalSize = t.store.size.bind(t.store)
    t.store.size = async (asked) => {
      const size = await originalSize(asked)
      await t.store.delete(sha) // GC removed bytes after preflight's size check.
      return size
    }
    try {
      const result = await api(t.app, deviceToken).post(`/v1/vaults/${vaultId}/commit`, {
        ops: [create('a.md', bytes)],
      })
      expect(result.status).toBe(404)
      expect(result.body.error.code).toBe('not_found')
      expect(await t.db.selectFrom('versions').select('id').execute()).toEqual([])
    } finally {
      t.store.size = originalSize
    }
  })

  it('keeps no reference to bytes the sweep removed while the reference was being made', async () => {
    const bytes = Buffer.from('a merge result nobody uploaded')
    const sha = shaOf(bytes)
    await t.store.put(bytes)

    // The sweep runs in the middle of `addRef`, where it asks whether the bytes are there.
    let sweep: Promise<number> | undefined
    const store = Object.create(t.store) as BlobStore
    store.has = async (asked: string) => {
      const there = await t.store.has(asked)
      // Past every grace: nothing but a row keeps these bytes from the sweep.
      sweep ??= collectUnreferenced({ db: t.db, store: t.store }, new Date(Date.now() + DAY_MS))
      // The sweep is waited for until it finishes or is held up by the commit's own row.
      await Promise.race([sweep, sleep(300)])
      return there
    }

    const at = new Date().toISOString()
    const committed = await t.db
      .transaction()
      .execute((trx) => addRef(trx, store, sha, bytes.length, at))
      .then(
        () => true,
        () => false
      )
    await sweep

    const row = await t.db
      .selectFrom('blobs')
      .select('refs')
      .where('sha', '=', sha)
      .executeTakeFirst()
    if (committed) {
      expect(row?.refs).toBe(1)
      expect(await t.store.has(sha)).toBe(true)
    } else {
      expect(row).toBeUndefined()
    }
  })
}

describe('a reference and the sweep', () => refRace('sqlite'))
describe.skipIf(!hasPgTestDb)('a reference and the sweep on postgres', () => refRace('pg'))
