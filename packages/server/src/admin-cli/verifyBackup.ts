import { BlobStore } from '../blobs/store.js'
import { createDb } from '../db/connect.js'

/** Validate against the snapshot, never the live DB which retention may already have changed. */
export async function verifyBackup(database: string, blobs: string, key: Buffer): Promise<void> {
  const snapshot = createDb(`sqlite://${database}`)
  try {
    const store = new BlobStore(blobs, key)
    const rows = await snapshot.db.selectFrom('versions').select('blob_sha').distinct().execute()
    for (const { blob_sha: sha } of rows) {
      if (sha !== null && !(await store.intact(sha))) {
        throw new Error(
          `incomplete backup: missing or corrupt blob ${sha}; retry into a new directory`
        )
      }
    }
  } finally {
    await snapshot.close()
  }
}
