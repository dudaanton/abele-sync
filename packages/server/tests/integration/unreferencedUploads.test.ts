import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import type { Dialect } from '../../src/db/connect.js'
import { runRetention } from '../../src/history/retention.js'
import { api } from '../helpers/client.js'
import { commit, create, octet, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, TEST_PASSWORD, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'

/**
 * Bytes a device uploads and never commits. `PUT /blobs/:sha` stores them at once, but a
 * version is what makes a `blobs` row, and retention only ever looked at rows: uploads nobody
 * named sat on the disk for good, counted against nothing. They now count against the vault's
 * quota while they wait, go once they have waited a day, and go at once when the device that
 * sent them is revoked.
 */

const HOUR_MS = 60 * 60 * 1000
const BASE = new Date('2026-03-01T00:00:00.000Z')

function unreferencedUploads(dialect: Dialect): void {
  let t: TestApp
  let clock: Date
  let accountToken: string
  let vaultId: string
  let device: { deviceId: string; deviceToken: string }

  const gc = (now: Date) =>
    runRetention({
      db: t.db,
      dialect,
      store: t.store,
      uploads: createUploadManager({
        config: loadConfig({
          ABELE_MASTER_KEY: 'ab'.repeat(32),
          ABELE_TOKEN_PEPPER: TEST_TOKEN_PEPPER,
          ABELE_BLOB_DIR: t.store.dir,
        }),
        db: t.db,
        store: t.store,
        now: () => now,
      }),
      idempotencyTtlMs: 24 * HOUR_MS,
      now: () => now,
    })

  const put = (token: string, text: string) =>
    api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${shaOf(text)}`,
      payload: Buffer.from(text),
      headers: octet,
    })

  beforeEach(async () => {
    clock = new Date(BASE)
    t = await buildTestApp({ dialect, now: () => clock })
    accountToken = (await t.account()).accountToken
    vaultId = (await t.vault(accountToken)).vaultId
    device = await t.device(accountToken, vaultId)
  })
  afterEach(async () => {
    await t.close()
  })

  it('removes bytes nobody committed once they have waited a day, and keeps what a version names', async () => {
    const orphan = await putBlob(t.app, device.deviceToken, 'never committed')
    const named = await putBlob(t.app, device.deviceToken, 'committed')
    await commit(t.app, device.deviceToken, vaultId, [create('kept.md', 'committed')])

    // Within the day the upload is somebody's commit in the making: it stays.
    await gc(new Date(BASE.getTime() + 2 * HOUR_MS))
    expect(await t.store.has(orphan)).toBe(true)

    clock = new Date(BASE.getTime() + 20 * HOUR_MS)
    const fresh = await putBlob(t.app, device.deviceToken, 'uploaded later')
    await gc(new Date(BASE.getTime() + 25 * HOUR_MS))
    expect(await t.store.has(orphan)).toBe(false)
    expect(await t.store.has(named)).toBe(true)
    expect(await t.store.has(fresh)).toBe(true)
  })

  it('counts uploads nobody has committed against the quota, and frees them once committed', async () => {
    await api(t.app, device.deviceToken).patch(`/v1/vaults/${vaultId}/settings`, {
      quota_bytes: 30,
      account_password: TEST_PASSWORD,
    })
    expect((await put(device.deviceToken, 'a'.repeat(12))).status).toBe(201)
    expect((await put(device.deviceToken, 'b'.repeat(12))).status).toBe(201)
    // Sending the same bytes again does not count them twice.
    expect((await put(device.deviceToken, 'b'.repeat(12))).status).toBe(201)
    // Only the other uploads leave no room: worth asking again once they are committed.
    const over = await put(device.deviceToken, 'c'.repeat(12))
    expect(over.status).toBe(409)
    expect(over.body.error.code).toBe('quota_waiting')
    expect(await t.store.has(shaOf('c'.repeat(12)))).toBe(false)

    // Committed, they are live bytes the quota counts at commit time, not waiting ones.
    await commit(t.app, device.deviceToken, vaultId, [create('a.md', 'a'.repeat(12))])
    expect((await put(device.deviceToken, 'c'.repeat(12))).status).toBe(201)
  })

  it('removes a revoked device’s uncommitted uploads at once, and nobody else’s', async () => {
    const other = await t.device(accountToken, vaultId, 'other')
    const mine = await putBlob(t.app, device.deviceToken, 'mine only')
    const shared = await putBlob(t.app, device.deviceToken, 'both of us')
    await putBlob(t.app, other.deviceToken, 'both of us')
    const theirs = await putBlob(t.app, other.deviceToken, 'theirs')
    const named = await putBlob(t.app, device.deviceToken, 'named')
    await commit(t.app, device.deviceToken, vaultId, [create('named.md', 'named')])

    const revoked = await api(t.app, accountToken).raw({
      method: 'DELETE',
      url: `/v1/devices/${device.deviceId}`,
    })
    expect(revoked.status).toBe(204)
    expect(await t.store.has(mine)).toBe(false)
    expect(await t.store.has(shared)).toBe(true)
    expect(await t.store.has(theirs)).toBe(true)
    expect(await t.store.has(named)).toBe(true)
  })
}

describe('unreferenced uploads', () => unreferencedUploads('sqlite'))
describe.skipIf(!hasPgTestDb)('unreferenced uploads on postgres', () => unreferencedUploads('pg'))
