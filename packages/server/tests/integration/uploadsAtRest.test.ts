import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UploadManager } from '../../src/blobs/uploads.js'
import { shaOf } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/**
 * A resumable upload keeps its parts on the server's volume until it is completed, and that
 * volume is what `ABELE_MASTER_KEY` protects: the parts are sealed with it as the blobs are,
 * and joining them never writes the plaintext out whole.
 */

const MARKER = 'a secret line nobody may read off the volume'

/** Every file under `dir`, recursively, as bytes. */
async function everyFile(dir: string): Promise<Buffer[]> {
  const found: Buffer[] = []
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await everyFile(path)))
    else if (entry.isFile()) found.push(await readFile(path))
  }
  return found
}

const readable = async (dir: string): Promise<boolean> =>
  (await everyFile(dir)).some((bytes) => bytes.includes(MARKER))

describe('uploads at rest', () => {
  let t: TestApp
  let tmpDir: string
  let uploads: UploadManager
  beforeEach(async () => {
    t = await buildTestApp()
    tmpDir = join(t.dir, 'blobs', 'uploads')
    uploads = new UploadManager(t.db, t.store, tmpDir, 1024, 1_000_000)
  })
  afterEach(async () => {
    await t.close()
  })

  it('keeps no plaintext of an upload on the volume, neither its parts nor the joined file', async () => {
    const text = `${MARKER}\n`.repeat(40)
    const bytes = Buffer.from(text)
    const { upload_id, parts } = await uploads.begin(shaOf(bytes), bytes.length)
    for (let index = 0; index < parts; index++) {
      await uploads.putPart(upload_id, index, bytes.subarray(index * 1024, (index + 1) * 1024))
    }
    expect(await readable(tmpDir)).toBe(false)

    // Whatever the store is handed to file, the volume holds no plaintext at that moment.
    let seenDuringJoin = false
    const store = t.store as unknown as Record<string, unknown>
    for (const name of ['put', 'putFile', 'putChunks']) {
      const original = store[name]
      if (typeof original !== 'function') continue
      store[name] = async (...args: unknown[]) => {
        if (await readable(tmpDir)) seenDuringJoin = true
        return (original as (...a: unknown[]) => Promise<unknown>).apply(t.store, args)
      }
    }
    expect(await uploads.complete(upload_id)).toEqual({ sha: shaOf(bytes), size: bytes.length })
    expect(seenDuringJoin).toBe(false)
    expect((await t.store.get(shaOf(bytes))).toString()).toBe(text)
  })

  it('refuses a part that was changed on the volume', async () => {
    const bytes = Buffer.alloc(2048, 7)
    const { upload_id } = await uploads.begin(shaOf(bytes), bytes.length)
    await uploads.putPart(upload_id, 0, bytes.subarray(0, 1024))
    await uploads.putPart(upload_id, 1, bytes.subarray(1024))
    // Part 1 sealed under part 0's name: bound to its place, it does not open there.
    await writeFile(join(tmpDir, upload_id, '0'), await readFile(join(tmpDir, upload_id, '1')))
    await expect(uploads.complete(upload_id)).rejects.toThrow()
    expect(await t.store.has(shaOf(bytes))).toBe(false)
  })

  it('sweeps a part folder no upload names', async () => {
    const stray = join(tmpDir, 'left-by-a-crash')
    await mkdir(stray, { recursive: true })
    await writeFile(join(stray, '0'), 'old part')
    const live = await uploads.begin('4'.repeat(64), 10)
    await uploads.sweep(new Date('2000-01-01T00:00:00.000Z'))
    expect(await readdir(tmpDir)).toEqual([live.upload_id])
  })
})
