import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createUploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetention } from '../../src/history/retention.js'
import { buildTestApp, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'
import { SimDevice, converge } from './sim.js'

/**
 * A phone that stays offline past `attachments_days` and comes back with an
 * edit: the version it edited from is gone from the server, and the server
 * meets that as a head that changed rather than as a mistake. Nothing is
 * rejected, and both devices end on the same bytes.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

let t: TestApp
let clock = new Date('2026-01-01T00:00:00.000Z')

const sim = async (account: string, vaultId: string, name: string): Promise<SimDevice> => {
  const { deviceToken } = await t.device(account, vaultId, name)
  return new SimDevice(t.app, vaultId, deviceToken, name)
}

/** Retention, as the admin CLI's `gc` runs it, at the clock's current time. */
const gc = () => {
  const config = loadConfig({
    ABELE_MASTER_KEY: 'ab'.repeat(32),
    ABELE_TOKEN_PEPPER: TEST_TOKEN_PEPPER,
    ABELE_BLOB_DIR: t.store.dir,
  })
  return runRetention({
    db: t.db,
    dialect: 'sqlite',
    store: t.store,
    uploads: createUploadManager({ config, db: t.db, store: t.store, now: () => clock }),
    idempotencyTtlMs: 24 * HOUR_MS,
    now: () => clock,
  })
}

/** The ids of a file's versions, oldest first. */
const versionsOf = async (fileId: string | undefined): Promise<string[]> =>
  (
    await t.db
      .selectFrom('versions')
      .select('id')
      .where('file_id', '=', fileId ?? '')
      .orderBy('no')
      .execute()
  ).map((row) => row.id)

/** A laptop and a phone that both hold `pic.bin`, the laptop edits it, and retention prunes the phone's base. */
async function offlinePhone(): Promise<{
  laptop: SimDevice
  phone: SimDevice
  fromLaptop: Buffer
}> {
  // An account of its own: the clock only moves forward, and account tokens last an hour.
  const account = (await t.account()).accountToken
  const { vaultId } = await t.vault(account)
  const laptop = await sim(account, vaultId, 'laptop')
  const phone = await sim(account, vaultId, 'phone')
  laptop.write('pic.bin', randomBytes(32))
  await laptop.sync()
  await phone.sync()
  const base = phone.state.get('pic.bin')?.versionId

  const fromLaptop = randomBytes(32)
  laptop.write('pic.bin', fromLaptop)
  await laptop.sync()
  // Fifteen days pass: past the fourteen an attachment keeps, and the phone's base goes.
  clock = new Date(clock.getTime() + 15 * DAY_MS)
  const report = await gc()
  expect(report.versions_removed).toBeGreaterThanOrEqual(1)
  const left = await versionsOf(phone.state.get('pic.bin')?.fileId)
  expect(left).not.toContain(base)
  expect(left).toEqual([laptop.state.get('pic.bin')?.versionId])
  return { laptop, phone, fromLaptop }
}

beforeAll(async () => {
  t = await buildTestApp({ now: () => clock })
})
afterAll(async () => {
  await t.close()
})

describe('a phone offline past attachments_days', () => {
  it('edits the attachment from its pruned base; the newer edit applies, and both converge on it', async () => {
    const { laptop, phone } = await offlinePhone()
    const fromPhone = randomBytes(32)
    phone.write('pic.bin', fromPhone)
    const pushed = await phone.sync()
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'applied', path: 'pic.bin' }),
    ])
    expect(phone.rejected).toEqual([])

    await converge(laptop, phone)
    for (const d of [laptop, phone])
      expect(d.disk.get('pic.bin')?.content.equals(fromPhone)).toBe(true)
    expect(laptop.state.get('pic.bin')?.versionId).toBe(phone.state.get('pic.bin')?.versionId)
  })

  it('edits it with an older mtime; the laptop’s bytes win, and the phone takes them', async () => {
    const { laptop, phone, fromLaptop } = await offlinePhone()
    phone.write('pic.bin', randomBytes(32), 1)
    const pushed = await phone.sync()
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'merged', path: 'pic.bin' }),
    ])
    expect(phone.rejected).toEqual([])

    await converge(laptop, phone)
    for (const d of [laptop, phone])
      expect(d.disk.get('pic.bin')?.content.equals(fromLaptop)).toBe(true)
  })
})
