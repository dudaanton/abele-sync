/** Real SIGKILL fixture. Imports built production modules; never throws to simulate death. */
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createDb } from '../../dist/db/connect.js'
import { runMigrations } from '../../dist/db/migrate.js'
import { BlobStore } from '../../dist/blobs/store.js'
import { addRef } from '../../dist/blobs/refs.js'
import { collectUnreferenced } from '../../dist/blobs/pending.js'
import { runRetention } from '../../dist/history/retention.js'
import { UploadManager } from '../../dist/blobs/uploads.js'

const [dir, mode, phase] = process.argv.slice(2)
const handle = createDb(`sqlite://${join(dir, 'server.db')}`)
await runMigrations(handle.db)
const { db } = handle
await mkdir(join(dir, 'blobs'), { recursive: true })
const store = new BlobStore(join(dir, 'blobs'), Buffer.from('ab'.repeat(32), 'hex'))
const uploads = new UploadManager(db, store, join(dir, 'uploads'), 4, 1000)
const bytes = Buffer.from('crash-safe-content')
const barrier = async () => {
  process.send({ barrier: mode })
  await new Promise(() => {})
}
const sweep = () =>
  runRetention({
    db,
    dialect: 'sqlite',
    store,
    uploads,
    idempotencyTtlMs: 86400000,
    now: () => new Date('2030-01-01T00:00:00Z'),
  })

try {
  if (mode.startsWith('gc')) {
    const { sha } = await store.put(bytes)
    if (phase === 'cut') {
      if (mode.includes('referenced')) {
        const at = '2020-01-01T00:00:00Z'
        await db.transaction().execute((trx) => addRef(trx, store, sha, bytes.length, at))
        await db.updateTable('blobs').set({ refs: 0 }).where('sha', '=', sha).execute()
      }
      const remove = store.delete.bind(store)
      store.delete = async (sha) => {
        if (mode.endsWith('after-delete')) await remove(sha)
        await barrier()
      }
      if (mode.includes('referenced')) await sweep()
      else await collectUnreferenced({ db, store }, new Date('2030-01-01'))
    } else {
      // Fresh process, same production sweep, then retry the identical upload and reference.
      await sweep()
      await store.put(bytes)
      let committed = false,
        error = null
      try {
        await db
          .transaction()
          .execute((trx) => addRef(trx, store, sha, bytes.length, new Date().toISOString()))
        committed = true
      } catch (e) {
        error = String(e)
      }
      const row = await db
        .selectFrom('blobs')
        .select('refs')
        .where('sha', '=', sha)
        .executeTakeFirst()
      process.send({ result: { committed, refs: row?.refs, present: await store.has(sha), error } })
    }
  } else if (mode === 'upload-completing') {
    if (phase === 'cut') {
      const { createHash } = await import('node:crypto')
      const sha = createHash('sha256').update(bytes).digest('hex')
      const opened = await uploads.begin(sha, bytes.length)
      for (let i = 0; i < opened.parts; i++) {
        await uploads.putPart(opened.upload_id, i, bytes.subarray(i * 4, (i + 1) * 4))
      }
      store.putChunks = barrier
      await uploads.complete(opened.upload_id)
    } else {
      const row = await db.selectFrom('uploads').selectAll().executeTakeFirstOrThrow()
      let completed = false,
        error = null
      try {
        // Production startup recovers completion claims before accepting requests.
        await uploads.recoverCompletions()
        completed =
          !(await db
            .selectFrom('uploads')
            .select('id')
            .where('id', '=', row.id)
            .executeTakeFirst()) && (await store.get(row.sha)).equals(bytes)
      } catch (e) {
        error = String(e)
      }
      process.send({ result: { completed, claimed: row.completing_at !== null, error } })
    }
  }
} catch (error) {
  process.send({ error: String(error) })
  process.exitCode = 1
} finally {
  await handle.close()
  process.disconnect()
}
