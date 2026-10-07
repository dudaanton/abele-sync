import { createHash } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { addRef, releaseRef } from '../../src/blobs/refs.js'
import { UploadManager } from '../../src/blobs/uploads.js'
import { api } from '../helpers/client.js'
import { commit, create } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

const shaOf = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const octet = { 'content-type': 'application/octet-stream' }

/** A device and the vault it belongs to. */
interface Device {
  token: string
  vaultId: string
}

async function enrol(t: TestApp): Promise<Device> {
  const { accountToken } = await t.account()
  const { vaultId } = await t.vault(accountToken)
  return { token: (await t.device(accountToken, vaultId)).deviceToken, vaultId }
}

const deviceFor = async (t: TestApp): Promise<string> => (await enrol(t)).token

/**
 * Commit a version naming the bytes. A blob exists for a vault once a version
 * of that vault names it: until then, HEAD and GET are 404 even for the device
 * that uploaded it.
 */
const reference = (t: TestApp, d: Device, path: string, bytes: Buffer): Promise<unknown> =>
  commit(t.app, d.token, d.vaultId, [create(path, bytes)])

/** Is anything at that path? Used to see that a swept upload really is gone. */
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

describe('blob routes', () => {
  let t: TestApp, device: Device, token: string
  beforeAll(async () => {
    t = await buildTestApp()
    device = await enrol(t)
    token = device.token
  })
  afterAll(async () => {
    await t.close()
  })

  it('HEAD 404, PUT 201 twice over, HEAD 204 once a version names it, GET whole and with Range', async () => {
    const body = Buffer.from('0123456789')
    const s = shaOf(body)
    expect((await api(t.app, token).raw({ method: 'HEAD', url: `/v1/blobs/${s}` })).status).toBe(
      404
    )
    const put = await api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}`,
      payload: body,
      headers: octet,
    })
    expect(put.status).toBe(201)
    // Whether the bytes were there already is never said: the second PUT is a 201 like the first.
    const again = await api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}`,
      payload: body,
      headers: octet,
    })
    expect(again.status).toBe(201)
    expect(again.body).toEqual({ sha: s, size: 10 })
    // Uploaded, but no version of the vault names it yet: not there, as far as the vault knows.
    expect((await api(t.app, token).raw({ method: 'HEAD', url: `/v1/blobs/${s}` })).status).toBe(
      404
    )
    await reference(t, device, 'digits.txt', body)
    expect((await api(t.app, token).raw({ method: 'HEAD', url: `/v1/blobs/${s}` })).status).toBe(
      204
    )
    const whole = await api(t.app, token).raw({ method: 'GET', url: `/v1/blobs/${s}` })
    expect(whole.status).toBe(200)
    expect(whole.raw).toBe('0123456789')
    expect(whole.headers['content-length']).toBe('10')
    const get = await api(t.app, token).raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=2-4' },
    })
    expect(get.status).toBe(206)
    expect(get.raw).toBe('234')
    expect(get.headers['content-range']).toBe('bytes 2-4/10')
    const tail = await api(t.app, token).raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=-3' },
    })
    expect(tail.status).toBe(206)
    expect(tail.raw).toBe('789')
    const bad = await api(t.app, token).raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=20-30' },
    })
    expect(bad.status).toBe(416)
  })

  it('requires a device token', async () => {
    expect(
      (await api(t.app).raw({ method: 'HEAD', url: `/v1/blobs/${'a'.repeat(64)}` })).status
    ).toBe(401)
  })

  it('refuses a body whose hash differs', async () => {
    const r = await api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${'c'.repeat(64)}`,
      payload: Buffer.from('nope'),
      headers: octet,
    })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('hash_mismatch')
  })

  it('uploads in parts and completes', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    const d = await enrol(tt)
    const tok = d.token
    const big = Buffer.alloc(3 * 1024 + 100, 1)
    const s = shaOf(big)
    const begin = await api(tt.app, tok).post(`/v1/blobs/${s}/upload`, { size: big.length })
    expect(begin.status).toBe(201)
    expect(begin.body.part_size).toBe(1024)
    expect(begin.body.parts).toBe(4)
    const id = begin.body.upload_id
    for (let i = 0; i < 4; i++) {
      const part = big.subarray(i * 1024, Math.min((i + 1) * 1024, big.length))
      const r = await api(tt.app, tok).raw({
        method: 'PUT',
        url: `/v1/blobs/${s}/upload/${id}/${i}`,
        payload: part,
        headers: octet,
      })
      expect(r.status).toBe(204)
    }
    const done = await api(tt.app, tok).post(`/v1/blobs/${s}/upload/${id}/complete`)
    expect(done.status).toBe(201)
    expect(done.body).toEqual({ sha: s, size: big.length })
    // In the store, and visible to the vault once a version names it — no sooner.
    expect(await tt.store.has(s)).toBe(true)
    expect((await api(tt.app, tok).raw({ method: 'HEAD', url: `/v1/blobs/${s}` })).status).toBe(404)
    await reference(tt, d, 'big.bin', big)
    expect((await api(tt.app, tok).raw({ method: 'HEAD', url: `/v1/blobs/${s}` })).status).toBe(204)
    expect((await api(tt.app, tok).post(`/v1/blobs/${s}/upload/${id}/complete`)).status).toBe(404)
    // The row and the part directory are both gone once the blob is in the store.
    expect(await tt.db.selectFrom('uploads').selectAll().execute()).toEqual([])
    expect(await exists(join(tt.dir, 'blobs', 'uploads', id))).toBe(false)
    await tt.close()
  })

  it('continues a device upload from parts persisted before a client restart', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    try {
      const tok = await deviceFor(tt)
      const big = Buffer.alloc(2048, 3)
      const sha = shaOf(big)
      const url = `/v1/blobs/${sha}/upload`
      const first = await api(tt.app, tok).post(url, { size: big.length })
      const id = first.body.upload_id
      expect(
        (
          await api(tt.app, tok).raw({
            method: 'PUT',
            url: `${url}/${id}/0`,
            payload: big.subarray(0, 1024),
            headers: octet,
          })
        ).status
      ).toBe(204)
      const resumed = await api(tt.app, tok).post(url, { size: big.length })
      expect(resumed.body).toMatchObject({ upload_id: id, received: [0] })
      expect(
        (
          await api(tt.app, tok).raw({
            method: 'PUT',
            url: `${url}/${id}/1`,
            payload: big.subarray(1024),
            headers: octet,
          })
        ).status
      ).toBe(204)
      expect((await api(tt.app, tok).post(`${url}/${id}/complete`)).status).toBe(201)
    } finally {
      await tt.close()
    }
  })

  it('refuses to complete with a part missing, and refuses a wrong-sized part', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    const tok = await deviceFor(tt)
    const big = Buffer.alloc(2048, 2)
    const s = shaOf(big)
    const {
      body: { upload_id },
    } = await api(tt.app, tok).post(`/v1/blobs/${s}/upload`, { size: 2048 })
    await api(tt.app, tok).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}/upload/${upload_id}/0`,
      payload: big.subarray(0, 1024),
      headers: octet,
    })
    const short = await api(tt.app, tok).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}/upload/${upload_id}/1`,
      payload: big.subarray(0, 10),
      headers: octet,
    })
    expect(short.status).toBe(400)
    const r = await api(tt.app, tok).post(`/v1/blobs/${s}/upload/${upload_id}/complete`)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_request')
    expect(r.body.error.details.missing).toEqual([1])
    await tt.close()
  })

  it('refuses a simple PUT over the simple limit and an upload over the file limit', async () => {
    const tt = await buildTestApp({ simpleUploadBytes: 100, maxFileBytes: 1000 })
    const tok = await deviceFor(tt)
    const b = Buffer.alloc(101, 3)
    const r = await api(tt.app, tok).raw({
      method: 'PUT',
      url: `/v1/blobs/${shaOf(b)}`,
      payload: b,
      headers: octet,
    })
    expect(r.status).toBe(413)
    expect(r.body.error.code).toBe('too_large')
    const u = await api(tt.app, tok).post(`/v1/blobs/${'d'.repeat(64)}/upload`, { size: 1001 })
    expect(u.status).toBe(413)
    expect(u.body.error.code).toBe('too_large')
    await tt.close()
  })

  it('stores an empty file, which is a blob like any other', async () => {
    const empty = Buffer.alloc(0)
    const s = shaOf(empty)
    const put = await api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}`,
      payload: empty,
      headers: octet,
    })
    expect(put.status).toBe(201)
    expect(put.body).toEqual({ sha: s, size: 0 })
    await reference(t, device, 'empty.md', empty)
    const get = await api(t.app, token).raw({ method: 'GET', url: `/v1/blobs/${s}` })
    expect(get.status).toBe(200)
    expect(get.headers['content-length']).toBe('0')
    // There is no byte to ask for, so every range is unsatisfiable.
    const ranged = await api(t.app, token).raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=0-0' },
    })
    expect(ranged.status).toBe(416)
    expect(ranged.headers['content-range']).toBe('bytes */0')
  })

  it('answers not_found for a blob nobody has stored', async () => {
    const r = await api(t.app, token).raw({ method: 'GET', url: `/v1/blobs/${'9'.repeat(64)}` })
    expect(r.status).toBe(404)
    expect(r.body.error.code).toBe('not_found')
  })

  it('serves a blob only to the vault whose versions name it', async () => {
    const a = await enrol(t)
    const b = await enrol(t)
    const body = Buffer.from('held by vault A, not by vault B')
    const s = shaOf(body)
    const head = (d: Device) => api(t.app, d.token).raw({ method: 'HEAD', url: `/v1/blobs/${s}` })
    const get = (d: Device) => api(t.app, d.token).raw({ method: 'GET', url: `/v1/blobs/${s}` })
    const put = (d: Device) =>
      api(t.app, d.token).raw({
        method: 'PUT',
        url: `/v1/blobs/${s}`,
        payload: body,
        headers: octet,
      })

    // Before any commit, even the uploader is told there is nothing there.
    expect((await put(a)).status).toBe(201)
    expect((await head(a)).status).toBe(404)
    expect((await get(a)).status).toBe(404)

    await reference(t, a, 'Mine.md', body)
    expect((await head(a)).status).toBe(204)
    expect((await get(a)).status).toBe(200)
    expect((await get(a)).raw).toBe(body.toString())

    // Another vault: the same sha, the same bytes in the store, and nothing to be learnt about it.
    expect((await head(b)).status).toBe(404)
    const refused = await get(b)
    expect(refused.status).toBe(404)
    expect(refused.body.error.code).toBe('not_found')
    // A PUT is 201 whether the bytes were there or not, so B cannot ask that way either.
    expect((await put(b)).status).toBe(201)
    expect((await head(b)).status).toBe(404)
    await reference(t, b, 'Mine too.md', body)
    expect((await head(b)).status).toBe(204)
    expect((await get(b)).status).toBe(200)
  })

  it('refuses an unauthenticated PUT, and stores nothing', async () => {
    const body = Buffer.from('no token here')
    const r = await api(t.app).raw({
      method: 'PUT',
      url: `/v1/blobs/${shaOf(body)}`,
      payload: body,
      headers: octet,
    })
    expect(r.status).toBe(401)
    expect(await t.store.has(shaOf(body))).toBe(false)
  })

  it('takes a sha that is not sixty-four hex characters as an invalid request', async () => {
    const r = await api(t.app, token).raw({ method: 'GET', url: '/v1/blobs/not-a-sha' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_request')
  })

  it('serves the ranges a resuming client asks for', async () => {
    const body = Buffer.from('0123456789')
    const s = shaOf(body)
    await api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}`,
      payload: body,
      headers: octet,
    })
    await reference(t, device, 'ranges.txt', body)
    const client = api(t.app, token)

    const whole = await client.raw({ method: 'GET', url: `/v1/blobs/${s}` })
    expect(whole.headers['cache-control']).toBe('private, immutable, max-age=31536000')
    expect(whole.headers['content-type']).toBe('application/octet-stream')
    expect(whole.headers['accept-ranges']).toBe('bytes')

    // A suffix longer than the blob is the whole blob, and still a 206.
    const all = await client.raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=-100' },
    })
    expect(all.status).toBe(206)
    expect(all.raw).toBe('0123456789')
    expect(all.headers['content-range']).toBe('bytes 0-9/10')

    // An open end runs to the last byte, and an end past the last byte is clamped.
    const open = await client.raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=7-' },
    })
    expect(open.status).toBe(206)
    expect(open.raw).toBe('789')
    const clamped = await client.raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=8-99' },
    })
    expect(clamped.status).toBe(206)
    expect(clamped.headers['content-range']).toBe('bytes 8-9/10')
    expect(clamped.headers['content-length']).toBe('2')

    // A start at or past the end, and more than one range, are both unsatisfiable.
    const past = await client.raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=10-' },
    })
    expect(past.status).toBe(416)
    expect(past.headers['content-range']).toBe('bytes */10')
    const many = await client.raw({
      method: 'GET',
      url: `/v1/blobs/${s}`,
      headers: { range: 'bytes=0-1,4-5' },
    })
    expect(many.status).toBe(416)
  })

  it('refuses a part index the upload does not have', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    const tok = await deviceFor(tt)
    const big = Buffer.alloc(2048, 4)
    const s = shaOf(big)
    const begin = await api(tt.app, tok).post(`/v1/blobs/${s}/upload`, { size: 2048 })
    const id = begin.body.upload_id
    const client = api(tt.app, tok)

    for (const index of ['2', '-1', 'x']) {
      const r = await client.raw({
        method: 'PUT',
        url: `/v1/blobs/${s}/upload/${id}/${index}`,
        payload: big.subarray(0, 1024),
        headers: octet,
      })
      expect(r.status).toBe(400)
      expect(r.body.error.code).toBe('invalid_request')
    }
    const unknown = await client.raw({
      method: 'PUT',
      url: `/v1/blobs/${s}/upload/no-such-upload/0`,
      payload: big.subarray(0, 1024),
      headers: octet,
    })
    expect(unknown.status).toBe(404)
    await tt.close()
  })

  it('takes parts that arrive all at once', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    const tok = await deviceFor(tt)
    const client = api(tt.app, tok)

    // Eight parts in flight together, five times over: enough for a lost index to show.
    for (let round = 0; round < 5; round++) {
      const big = Buffer.alloc(8 * 1024, round)
      const s = shaOf(big)
      const begin = await client.post(`/v1/blobs/${s}/upload`, { size: big.length })
      const id = begin.body.upload_id
      const sent = await Promise.all(
        [...Array(8).keys()].map((index) =>
          client.raw({
            method: 'PUT',
            url: `/v1/blobs/${s}/upload/${id}/${index}`,
            payload: big.subarray(index * 1024, (index + 1) * 1024),
            headers: octet,
          })
        )
      )
      expect(sent.map((r) => r.status)).toEqual(Array(8).fill(204))
      const done = await client.post(`/v1/blobs/${s}/upload/${id}/complete`)
      expect(done.status).toBe(201)
      expect(done.body).toEqual({ sha: s, size: big.length })
      expect(Buffer.compare(await tt.store.get(s), big)).toBe(0)
    }
    await tt.close()
  })

  it('counts a part that is not on disk as missing, whatever the row remembers', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    const tok = await deviceFor(tt)
    const big = Buffer.alloc(2048, 6)
    const s = shaOf(big)
    const begin = await api(tt.app, tok).post(`/v1/blobs/${s}/upload`, { size: 2048 })
    const id = begin.body.upload_id
    for (const index of [0, 1]) {
      await api(tt.app, tok).raw({
        method: 'PUT',
        url: `/v1/blobs/${s}/upload/${id}/${index}`,
        payload: big.subarray(index * 1024, (index + 1) * 1024),
        headers: octet,
      })
    }
    // The row says both parts arrived; the disk has lost one.
    await rm(join(tt.dir, 'blobs', 'uploads', id, '0'))
    const done = await api(tt.app, tok).post(`/v1/blobs/${s}/upload/${id}/complete`)
    expect(done.status).toBe(400)
    expect(done.body.error.code).toBe('invalid_request')
    expect(done.body.error.details.missing).toEqual([0])
    await tt.close()
  })

  it('refuses to complete an upload whose parts do not hash to the sha it named', async () => {
    const tt = await buildTestApp({ partBytes: 1024 })
    const tok = await deviceFor(tt)
    const s = 'e'.repeat(64)
    const begin = await api(tt.app, tok).post(`/v1/blobs/${s}/upload`, { size: 100 })
    const id = begin.body.upload_id
    await api(tt.app, tok).raw({
      method: 'PUT',
      url: `/v1/blobs/${s}/upload/${id}/0`,
      payload: Buffer.alloc(100, 5),
      headers: octet,
    })
    const done = await api(tt.app, tok).post(`/v1/blobs/${s}/upload/${id}/complete`)
    expect(done.status).toBe(400)
    expect(done.body.error.code).toBe('hash_mismatch')
    await tt.close()
  })

  it('rejects, rather than taking the process down, when the blob cannot be written', async () => {
    const tmpDir = join(t.dir, 'blobs', 'uploads')
    const uploads = new UploadManager(t.db, t.store, tmpDir, 1024, 1_000_000)
    const bytes = Buffer.alloc(512, 8)
    const sha = shaOf(bytes)
    const { upload_id } = await uploads.begin(sha, bytes.length)
    await uploads.putPart(upload_id, 0, bytes)

    // A file where the blob's folder goes: the store cannot put anything there.
    const folder = dirname(t.store.pathFor(sha))
    await mkdir(dirname(folder), { recursive: true })
    await writeFile(folder, 'in the way')
    // Reaching the next line at all is the assertion: an unwatched stream error would
    // have ended the whole test run rather than this call.
    await expect(uploads.complete(upload_id)).rejects.toThrow()
    // The parts are still there, so the client may complete again once the path is clear.
    expect(await exists(join(tmpDir, upload_id, '0'))).toBe(true)
    await rm(folder)
    expect(await t.store.has(sha)).toBe(false)
    expect(await uploads.complete(upload_id)).toEqual({ sha, size: bytes.length })
  })

  it('sweeps the uploads begun before the cut, and only those', async () => {
    const tmpDir = join(t.dir, 'blobs', 'uploads')
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const uploads = new UploadManager(t.db, t.store, tmpDir, 1024, 1_000_000, () => clock)

    const old = await uploads.begin('1'.repeat(64), 10)
    clock = new Date('2026-01-03T00:00:00.000Z')
    const fresh = await uploads.begin('2'.repeat(64), 10)

    expect(await uploads.sweep(new Date('2026-01-02T00:00:00.000Z'))).toBe(1)
    expect(await exists(join(tmpDir, old.upload_id))).toBe(false)
    expect(await exists(join(tmpDir, fresh.upload_id))).toBe(true)
    const left = await t.db.selectFrom('uploads').select('id').execute()
    expect(left.map((row) => row.id)).toEqual([fresh.upload_id])
    expect(await uploads.sweep(new Date('2026-01-02T00:00:00.000Z'))).toBe(0)
  })

  it('counts the versions that reference a blob, and floors the count at zero', async () => {
    const { sha: s, size } = await t.store.put(Buffer.from('a blob with references'))
    const row = () => t.db.selectFrom('blobs').selectAll().where('sha', '=', s).executeTakeFirst()

    await t.db
      .transaction()
      .execute((trx) => addRef(trx, t.store, s, size, '2026-01-01T00:00:00.000Z'))
    expect(await row()).toMatchObject({ refs: 1, size, created_at: '2026-01-01T00:00:00.000Z' })
    await t.db
      .transaction()
      .execute((trx) => addRef(trx, t.store, s, size, '2026-01-02T00:00:00.000Z'))
    expect(await row()).toMatchObject({
      refs: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      last_referenced_at: '2026-01-02T00:00:00.000Z',
    })

    // Three releases against two references: the count floors, and neither row nor file goes.
    for (let i = 0; i < 3; i++) await t.db.transaction().execute((trx) => releaseRef(trx, s))
    expect(await row()).toMatchObject({ refs: 0 })
    expect(await t.store.has(s)).toBe(true)

    // Releasing a sha nobody knows is quiet; referencing a blob that is not on disk is not.
    await t.db.transaction().execute((trx) => releaseRef(trx, '3'.repeat(64)))
    await expect(
      t.db
        .transaction()
        .execute((trx) => addRef(trx, t.store, '3'.repeat(64), 1, '2026-01-01T00:00:00.000Z'))
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})
