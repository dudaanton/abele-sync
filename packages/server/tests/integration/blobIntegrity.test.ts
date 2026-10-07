import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UploadManager } from '../../src/blobs/uploads.js'
import { shaOf } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/**
 * A blob is filed under the sha of its bytes, and nothing else may ever be filed there: not
 * bytes that changed between hashing them and sealing them, and not a copy that went bad on the
 * volume, which the next correct upload of those bytes replaces.
 */

describe('what a blob holds is what its name says', () => {
  let t: TestApp
  let uploads: UploadManager
  beforeEach(async () => {
    t = await buildTestApp()
    uploads = new UploadManager(t.db, t.store, join(t.dir, 'blobs', 'uploads'), 1024, 1_000_000)
  })
  afterEach(async () => {
    await t.close()
  })

  it('files no bytes but the ones it hashed, when the source changes between two reads', async () => {
    const right = Buffer.alloc(4096, 1)
    const wrong = Buffer.alloc(4096, 2)
    let reads = 0
    const source = async function* () {
      reads += 1
      yield reads === 1 ? right : wrong
    }
    const stored = await t.store.putChunks(shaOf(right), source).then(
      () => true,
      () => false
    )
    if (stored) expect(shaOf(await t.store.get(shaOf(right)))).toBe(shaOf(right))
    else expect(await t.store.has(shaOf(right))).toBe(false)
  })

  it('takes no part of an upload once its completion has begun', async () => {
    const bytes = Buffer.alloc(2048, 3)
    const sha = shaOf(bytes)
    const { upload_id } = await uploads.begin(sha, bytes.length)
    await uploads.putPart(upload_id, 0, bytes.subarray(0, 1024))
    await uploads.putPart(upload_id, 1, bytes.subarray(1024))

    let late: unknown = 'not tried'
    const putChunks = t.store.putChunks.bind(t.store)
    t.store.putChunks = async (expected, source) => {
      late = await uploads.putPart(upload_id, 1, Buffer.alloc(1024, 9)).then(
        () => 'taken',
        (error: unknown) => error
      )
      return putChunks(expected, source)
    }
    expect(await uploads.complete(upload_id)).toEqual({ sha, size: bytes.length })
    expect(late).toMatchObject({ code: 'conflict' })
    expect(shaOf(await t.store.get(sha))).toBe(sha)
  })

  it('replaces a blob that went bad on the volume with the next correct upload of it', async () => {
    const other = Buffer.from('some other bytes')
    const bytes = Buffer.from('the bytes this name stands for')
    const sha = shaOf(bytes)
    await t.store.put(other)
    // Another blob's envelope under this name: it does not open, and it is not these bytes.
    await mkdir(dirname(t.store.pathFor(sha)), { recursive: true })
    await copyFile(t.store.pathFor(shaOf(other)), t.store.pathFor(sha))

    await t.store.put(bytes, sha)
    expect((await t.store.get(sha)).equals(bytes)).toBe(true)

    await copyFile(t.store.pathFor(shaOf(other)), t.store.pathFor(sha))
    await t.store.putChunks(sha, async function* () {
      yield bytes
    })
    expect((await t.store.get(sha)).equals(bytes)).toBe(true)
  })
})
