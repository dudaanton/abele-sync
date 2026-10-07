import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createUploadManager } from '@abele/sync-server/src/blobs/uploads.js'
import { loadConfig } from '@abele/sync-server/src/config.js'
import { runRetention } from '@abele/sync-server/src/history/retention.js'
import { TEST_TOKEN_PEPPER } from '@abele/sync-server/tests/helpers/testApp.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge } from '../helpers/device.js'

/**
 * A phone that stays offline past `attachments_days` and comes back with an
 * edit: the version it edited from is gone from the server, and the server
 * meets that as a head that changed rather than as a mistake. Nothing is
 * rejected, and both devices end on the same bytes.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

let h: Harness
let clock = new Date('2026-01-01T00:00:00.000Z')

const device = async (account: string, vaultId: string, name: string): Promise<Device> => {
  const { deviceToken } = await h.device(account, vaultId, name)
  return new Device(h, vaultId, deviceToken, name)
}

/** Retention, as the admin CLI's `gc` runs it, at the clock's current time. */
const gc = () => {
  const config = loadConfig({
    ABELE_MASTER_KEY: 'ab'.repeat(32),
    ABELE_TOKEN_PEPPER: TEST_TOKEN_PEPPER,
    ABELE_BLOB_DIR: h.store.dir,
  })
  return runRetention({
    db: h.db,
    dialect: 'sqlite',
    store: h.store,
    uploads: createUploadManager({ config, db: h.db, store: h.store, now: () => clock }),
    idempotencyTtlMs: 24 * HOUR_MS,
    now: () => clock,
  })
}

/** The ids of a file's versions, oldest first. */
const versionsOf = async (fileId: string | undefined): Promise<string[]> =>
  (
    await h.db
      .selectFrom('versions')
      .select('id')
      .where('file_id', '=', fileId ?? '')
      .orderBy('no')
      .execute()
  ).map((row) => row.id)

/** A laptop and a phone that both hold `pic.bin`, the laptop edits it, and retention prunes the phone's base. */
async function offlinePhone(): Promise<{ laptop: Device; phone: Device; fromLaptop: Buffer }> {
  // An account of its own: the clock only moves forward, and account tokens last an hour.
  const account = (await h.account()).accountToken
  const { vaultId } = await h.vault(account)
  const laptop = await device(account, vaultId, 'laptop')
  const phone = await device(account, vaultId, 'phone')
  await laptop.write('pic.bin', randomBytes(32))
  await laptop.sync()
  await phone.sync()
  const base = (await phone.state.get('pic.bin'))?.versionId

  const fromLaptop = randomBytes(32)
  await laptop.write('pic.bin', fromLaptop)
  await laptop.sync()
  // Fifteen days pass: past the fourteen an attachment keeps, and the phone's base goes.
  clock = new Date(clock.getTime() + 15 * DAY_MS)
  const report = await gc()
  expect(report.versions_removed).toBeGreaterThanOrEqual(1)
  const left = await versionsOf((await phone.state.get('pic.bin'))?.fileId)
  expect(left).not.toContain(base)
  expect(left).toEqual([(await laptop.state.get('pic.bin'))?.versionId])
  return { laptop, phone, fromLaptop }
}

beforeAll(async () => {
  h = await serverHarness({ now: () => clock })
})
afterAll(async () => {
  await h.close()
})

describe('a phone offline past attachments_days', () => {
  it('edits the attachment from its pruned base; the newer edit applies, and both converge on it', async () => {
    const { laptop, phone } = await offlinePhone()
    const fromPhone = randomBytes(32)
    await phone.write('pic.bin', fromPhone)
    const pushed = (await phone.sync()).push.committed
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'applied', path: 'pic.bin' }),
    ])
    expect(phone.rejected).toEqual([])

    await converge(laptop, phone)
    for (const d of [laptop, phone]) expect(await d.holds('pic.bin', fromPhone)).toBe(true)
    expect((await laptop.state.get('pic.bin'))?.versionId).toBe(
      (await phone.state.get('pic.bin'))?.versionId
    )
  })

  it('edits it with an older mtime; the laptop’s bytes win, and the phone takes them', async () => {
    const { laptop, phone, fromLaptop } = await offlinePhone()
    await phone.write('pic.bin', randomBytes(32), 1)
    const pushed = (await phone.sync()).push.committed
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'merged', path: 'pic.bin' }),
    ])
    expect(phone.rejected).toEqual([])

    await converge(laptop, phone)
    for (const d of [laptop, phone]) expect(await d.holds('pic.bin', fromLaptop)).toBe(true)
  })
})
