import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { admitUpload } from '../../src/blobs/pending.js'
import type { Dialect } from '../../src/db/connect.js'
import { api } from '../helpers/client.js'
import { commit, create, octet, putBlob, shaOf } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'

/**
 * What a vault's uploads nobody has committed yet are counted as, against its quota: every byte
 * a device may leave on the volume — an upload's parts included — counted once it is proven,
 * counted atomically, owned by every device that waits on it, and gone with the device that
 * owned it.
 */

const PART = 64

function uploadAccounting(dialect: Dialect): void {
  let t: TestApp
  let accountToken: string
  let vaultId: string
  let a: { deviceId: string; deviceToken: string }
  let b: { deviceId: string; deviceToken: string }

  const put = (token: string, sha: string, body: string | Buffer) =>
    api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${sha}`,
      payload: Buffer.from(body),
      headers: octet,
    })
  const begin = (token: string, sha: string, size: number) =>
    api(t.app, token).post(`/v1/blobs/${sha}/upload`, { size })
  const quota = (bytes: number) =>
    api(t.app, a.deviceToken).patch(`/v1/vaults/${vaultId}/settings`, {
      quota_bytes: bytes,
      account_password: TEST_PASSWORD,
    })
  const partFolders = async () => readdir(join(t.store.dir, 'uploads')).catch(() => [] as string[])

  beforeEach(async () => {
    t = await buildTestApp({ dialect, partBytes: PART })
    accountToken = (await t.account()).accountToken
    vaultId = (await t.vault(accountToken)).vaultId
    a = await t.device(accountToken, vaultId, 'a')
    b = await t.device(accountToken, vaultId, 'b')
  })
  afterEach(async () => {
    await t.close()
  })

  it('does not let a failed upload change what an upload that worked is counted as', async () => {
    await quota(150)
    const big = 'x'.repeat(100)
    expect((await put(a.deviceToken, shaOf(big), big)).status).toBe(201)
    // One wrong byte under the same name: refused, and the 100 bytes stay counted.
    expect((await put(a.deviceToken, shaOf(big), 'y')).body.error.code).toBe('hash_mismatch')
    const next = 'z'.repeat(100)
    expect((await put(a.deviceToken, shaOf(next), next)).status).toBe(409)
  })

  it('counts nothing for an upload whose bytes did not hash to its name', async () => {
    await quota(150)
    const claimed = shaOf('w'.repeat(100))
    expect((await put(a.deviceToken, claimed, 'v'.repeat(100))).body.error.code).toBe(
      'hash_mismatch'
    )
    const real = 'u'.repeat(100)
    expect((await put(a.deviceToken, shaOf(real), real)).status).toBe(201)
  })

  it('counts every upload in progress, even two of the same bytes', async () => {
    await quota(150)
    const sha = shaOf('p'.repeat(100))
    expect((await begin(a.deviceToken, sha, 100)).status).toBe(201)
    const second = await begin(b.deviceToken, sha, 100)
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('quota_waiting')
  })

  it('keeps one upload in progress per device and bytes: a new one replaces the old', async () => {
    await quota(150)
    const sha = shaOf('q'.repeat(100))
    const first = await begin(a.deviceToken, sha, 100)
    await api(t.app, a.deviceToken).raw({
      method: 'PUT',
      url: `/v1/blobs/${sha}/upload/${first.body.upload_id}/0`,
      payload: Buffer.alloc(PART, 1),
      headers: octet,
    })
    const again = await begin(a.deviceToken, sha, 100)
    expect(again.status).toBe(201)
    expect(await partFolders()).toEqual([again.body.upload_id])
  })

  it('lets no two uploads at once past the quota together', async () => {
    await quota(100)
    // Two admissions started together, each for 60 bytes: one of them has to find the other.
    const admit = (deviceId: string, text: string) =>
      admitUpload(
        { db: t.db, dialect },
        { vaultId, deviceId, sha: shaOf(text), size: 60, at: new Date() }
      )
    const answers = await Promise.allSettled([
      admit(a.deviceId, 'm'.repeat(60)),
      admit(b.deviceId, 'n'.repeat(60)),
    ])
    expect(answers.map((answer) => answer.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('tells a device to wait, not to give up, when other uploads fill the quota', async () => {
    await quota(100)
    const theirs = 'k'.repeat(80)
    expect((await put(a.deviceToken, shaOf(theirs), theirs)).status).toBe(201)
    const mine = 'j'.repeat(30)
    const waiting = await put(b.deviceToken, shaOf(mine), mine)
    expect(waiting.body.error.code).toBe('quota_waiting')
    // More than the whole quota on its own can never fit: that is final.
    const huge = 'h'.repeat(101)
    expect((await put(b.deviceToken, shaOf(huge), huge)).body.error.code).toBe('quota_exceeded')

    // The other device commits: its bytes are live now, not waiting, and there is room.
    await commit(t.app, a.deviceToken, vaultId, [create('k.md', theirs)])
    expect((await put(b.deviceToken, shaOf(mine), mine)).status).toBe(201)
  })

  it('removes a revoked device’s uploads in progress, parts and all', async () => {
    const sha = shaOf('r'.repeat(100))
    const begun = await begin(a.deviceToken, sha, 100)
    await api(t.app, a.deviceToken).raw({
      method: 'PUT',
      url: `/v1/blobs/${sha}/upload/${begun.body.upload_id}/0`,
      payload: Buffer.alloc(PART, 2),
      headers: octet,
    })
    const mine = await begin(b.deviceToken, shaOf('s'.repeat(10)), 10)
    expect(
      (await api(t.app, accountToken).raw({ method: 'DELETE', url: `/v1/devices/${a.deviceId}` }))
        .status
    ).toBe(204)
    expect(await partFolders()).toEqual([mine.body.upload_id])
    const rows = await t.db.selectFrom('uploads').select('id').execute()
    expect(rows.map((row) => row.id)).toEqual([mine.body.upload_id])
  })

  it('keeps bytes another device still waits on when the last one to send them is revoked', async () => {
    const shared = await putBlob(t.app, a.deviceToken, 'both of us')
    await putBlob(t.app, b.deviceToken, 'both of us')
    expect(
      (await api(t.app, accountToken).raw({ method: 'DELETE', url: `/v1/devices/${b.deviceId}` }))
        .status
    ).toBe(204)
    expect(await t.store.has(shared)).toBe(true)
    const done = await commit(t.app, a.deviceToken, vaultId, [create('shared.md', 'both of us')])
    expect(done.results[0].status).toBe('applied')
  })
}

describe('uploads counted', () => uploadAccounting('sqlite'))
describe.skipIf(!hasPgTestDb)('uploads counted on postgres', () => uploadAccounting('pg'))
