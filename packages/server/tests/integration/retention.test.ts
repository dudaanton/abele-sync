import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { releaseRef } from '../../src/blobs/refs.js'
import { BlobStore } from '../../src/blobs/store.js'
import { createUploadManager, type UploadManager } from '../../src/blobs/uploads.js'
import { loadConfig } from '../../src/config.js'
import { runRetention } from '../../src/history/retention.js'
import { commit as directCommit } from '../../src/oplog/commit.js'
import { api } from '../helpers/client.js'
import { commit as post, create, putBlob as put, shaOf } from '../helpers/ops.js'
import { buildTestApp, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'

/**
 * Retention over a real vault: every version here was committed through the
 * routes, so what the sweep meets is what the server actually wrote. The clock
 * is a variable the app and the sweep both read, so history ages by assignment
 * rather than by waiting.
 *
 * The app runs on an in-memory database and `runRetention` is driven directly
 * against it; only the admin CLI, which opens its own connection, needs a file.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const BASE = new Date('2026-01-01T00:00:00.000Z')
const at = (ms: number): Date => new Date(BASE.getTime() + ms)
const days = (n: number): Date => at(n * DAY_MS)

let t: TestApp
let tok: string
let vaultId: string
let uploads: UploadManager
let clock: Date

const putBlob = (text: string): Promise<string> => put(t.app, tok, text)
const commit = (ops: unknown[]): Promise<any> => post(t.app, tok, vaultId, ops)

/** The ttl the server runs with: a key older than a day is nobody's retry. */
const IDEMPOTENCY_TTL_MS = 24 * HOUR_MS

const gc = (now: Date) =>
  runRetention({
    db: t.db,
    dialect: 'sqlite',
    store: t.store,
    uploads,
    idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
    now: () => now,
  })

const modify = (fileId: string, baseId: string, text: string, mtime = 2) => ({
  op: 'modify' as const,
  file_id: fileId,
  base_version_id: baseId,
  sha: shaOf(text),
  size: Buffer.byteLength(text),
  mtime,
})

/** Write a file and then rewrite it, once per text; the ids come back in order. */
async function history(
  path: string,
  texts: string[]
): Promise<{ fileId: string; versions: string[] }> {
  const versions: string[] = []
  let fileId = ''
  for (const [index, text] of texts.entries()) {
    await putBlob(text)
    const r =
      index === 0
        ? await commit([create(path, text)])
        : await commit([modify(fileId, versions[index - 1]!, text, index + 1)])
    fileId = r.results[0].file_id as string
    versions.push(r.results[0].version_id as string)
  }
  return { fileId, versions }
}

const versionIds = async (fileId: string): Promise<string[]> =>
  (
    await t.db
      .selectFrom('versions')
      .select('id')
      .where('file_id', '=', fileId)
      .orderBy('no')
      .execute()
  ).map((row) => row.id)

const blobRow = (sha: string) =>
  t.db.selectFrom('blobs').select('refs').where('sha', '=', sha).executeTakeFirst()

const headSeq = async (): Promise<number> =>
  (
    await t.db
      .selectFrom('vault_seq')
      .select('head_seq')
      .where('vault_id', '=', vaultId)
      .executeTakeFirstOrThrow()
  ).head_seq

/**
 * A store that runs something the moment retention asks it to remove a
 * particular sha — that is, after the row was tombstoned and before the bytes
 * are gone. It is the only way to stand inside the window on purpose.
 */
function raceOn(sha: string, race: () => Promise<void>): BlobStore {
  const store = new BlobStore(t.store.dir, Buffer.from('ab'.repeat(32), 'hex'))
  const remove = store.delete.bind(store)
  let raced = false
  store.delete = async (target: string): Promise<void> => {
    if (target === sha && !raced) {
      raced = true
      await race()
    }
    await remove(target)
  }
  return store
}

/** The state none of this may ever reach: a live file whose head has no bytes. */
async function everyHeadHasItsBytes(): Promise<void> {
  const heads = await t.db
    .selectFrom('files')
    .innerJoin('versions', 'versions.id', 'files.head_version_id')
    .select(['files.path as path', 'versions.blob_sha as sha'])
    .where('files.vault_id', '=', vaultId)
    .where('files.deleted_at', 'is', null)
    .execute()
  for (const head of heads) {
    if (head.sha === null) continue
    expect(await t.store.has(head.sha), `${head.path} has no bytes`).toBe(true)
  }
}

beforeEach(async () => {
  clock = new Date(BASE)
  t = await buildTestApp({ now: () => clock })
  const { accountToken } = await t.account()
  vaultId = (await t.vault(accountToken)).vaultId
  tok = (await t.device(accountToken, vaultId)).deviceToken
  const config = loadConfig({
    ABELE_MASTER_KEY: 'ab'.repeat(32),
    ABELE_TOKEN_PEPPER: TEST_TOKEN_PEPPER,
    ABELE_BLOB_DIR: t.store.dir,
  })
  uploads = createUploadManager({ config, db: t.db, store: t.store, now: () => clock })
})

afterEach(async () => {
  await t.close()
})

describe('retention', () => {
  it('drops the history a note has outlived and keeps its head', async () => {
    const { fileId, versions } = await history('n.md', ['v1', 'v2', 'v3'])

    const report = await gc(days(400))

    expect(report.versions_removed).toBe(2)
    expect(await versionIds(fileId)).toEqual([versions[2]])
    // The head's bytes stay; the two the history let go of are gone from both sides.
    expect(await t.store.has(shaOf('v3'))).toBe(true)
    expect(await blobRow(shaOf('v3'))).toEqual({ refs: 1 })
    expect(await t.store.has(shaOf('v1'))).toBe(false)
    expect(await t.store.has(shaOf('v2'))).toBe(false)
    expect(await blobRow(shaOf('v1'))).toBeUndefined()
    expect(await blobRow(shaOf('v2'))).toBeUndefined()
    expect(report.blobs_removed).toBe(2)
  })

  it('measures each version against its own kind of window', async () => {
    const note = await history('n.md', ['n1', 'n2', 'n3'])
    const attachment = await history('img.png', ['a1', 'a2', 'a3'])

    // Fifteen days: past the fourteen an attachment keeps, nowhere near a note's year.
    const report = await gc(days(15))

    expect(report.versions_removed).toBe(2)
    expect(await versionIds(note.fileId)).toEqual(note.versions)
    expect(await versionIds(attachment.fileId)).toEqual([attachment.versions[2]])
  })

  it('keeps the last version a deleted file had bytes in, however old', async () => {
    const { fileId, versions } = await history('d.md', ['d1', 'd2'])
    const deleted = await commit([{ op: 'delete', file_id: fileId, base_version_id: versions[1] }])

    const report = await gc(days(4000))

    expect(report.versions_removed).toBe(1)
    // The delete on top is the head; the version under it is what a restore brings back.
    expect(await versionIds(fileId)).toEqual([versions[1], deleted.results[0].version_id])
    expect(await t.store.has(shaOf('d2'))).toBe(true)
    expect(await t.store.has(shaOf('d1'))).toBe(false)
  })

  it('keeps the version a kept restore came through', async () => {
    const { fileId, versions } = await history('r.md', ['r1', 'r2'])
    const deleted = await commit([{ op: 'delete', file_id: fileId, base_version_id: versions[1] }])
    const restored = await commit([{ op: 'restore', file_id: fileId, version_id: versions[1] }])

    const report = await gc(days(400))

    expect(report.versions_removed).toBe(2)
    // The delete is where the restore came from; the two versions under it go.
    expect(await versionIds(fileId)).toEqual([
      deleted.results[0].version_id,
      restored.results[0].version_id,
    ])
    // The bytes the restore brought back are the restored version's, so they stay.
    expect(await t.store.has(shaOf('r2'))).toBe(true)
    expect(await t.store.has(shaOf('r1'))).toBe(false)
  })

  it('keeps the version a kept merge was based on', async () => {
    await putBlob('line1\n')
    await putBlob('line1\nline2\n')
    await putBlob('line0\nline1\n')
    const created = await commit([create('m.md', 'line1\n')])
    const fileId = created.results[0].file_id as string
    const first = created.results[0].version_id as string
    const second = (await commit([modify(fileId, first, 'line1\nline2\n')])).results[0]
      .version_id as string
    // A device that never saw the second version: the server merges onto the head.
    const merged = await commit([modify(fileId, first, 'line0\nline1\n', 3)])
    expect(merged.results[0].status).toBe('merged')

    const report = await gc(days(400))

    // The second version and the sent text kept under the merge age out; the base does not.
    expect(report.versions_removed).toBe(2)
    expect(await versionIds(fileId)).toEqual([first, merged.results[0].version_id])
    expect(await versionIds(fileId)).not.toContain(second)
  })

  it('meets a base it pruned as a head that changed, never as a rejection', async () => {
    const note = await history('n.md', ['v1\n', 'v2\n', 'v3\n'])
    const image = await history('img.png', ['a1', 'a2', 'a3'])
    const report = await gc(days(400))
    expect(report.versions_removed).toBe(4)
    expect(await versionIds(note.fileId)).toEqual([note.versions[2]])
    expect(await versionIds(image.fileId)).toEqual([image.versions[2]])

    // A device that last synced at v1 edits from it: keep the head and copy the offline edit.
    await putBlob('v1, edited offline\n')
    const conflict = await commit([
      modify(note.fileId, note.versions[0]!, 'v1, edited offline\n', 9),
    ])
    expect(conflict.results[0]).toMatchObject({
      status: 'conflict',
      path: 'n.md',
      version_id: note.versions[2],
    })
    expect((await t.store.get(conflict.results[0].sha)).toString()).toBe('v3\n')
    const copy = await t.db
      .selectFrom('versions')
      .select(['merge', 'op', 'blob_sha'])
      .where('id', '=', conflict.results[0].conflict_version_id)
      .executeTakeFirstOrThrow()
    expect(copy).toEqual({ merge: null, op: 'conflict', blob_sha: shaOf('v1, edited offline\n') })
    expect((await t.store.get(copy.blob_sha!)).toString()).toBe('v1, edited offline\n')
    expect(await versionIds(note.fileId)).toEqual([note.versions[2]])

    // An attachment goes to the newer mtime; the head's is 3.
    await putBlob('a1, edited offline')
    const newer = await commit([modify(image.fileId, image.versions[0]!, 'a1, edited offline', 99)])
    expect(newer.results[0]).toMatchObject({ status: 'applied', path: 'img.png' })
    await putBlob('a1, an older edit')
    const older = await commit([modify(image.fileId, image.versions[0]!, 'a1, an older edit', 1)])
    expect(older.results[0]).toMatchObject({ status: 'merged', sha: shaOf('a1, edited offline') })

    // A delete from the pruned base loses to the head; a move from it carries the head along.
    const gone = await commit([
      { op: 'delete', file_id: note.fileId, base_version_id: note.versions[0] },
    ])
    expect(gone.results[0]).toMatchObject({ status: 'merged', sha: conflict.results[0].sha })
    const moved = await commit([
      { op: 'move', file_id: note.fileId, base_version_id: note.versions[0], to_path: 'moved.md' },
    ])
    expect(moved.results[0]).toMatchObject({ status: 'applied', path: 'moved.md' })
    await everyHeadHasItsBytes()
  })

  it('keeps a blob a live head shares with a version it removed', async () => {
    const shared = await history('a.md', ['shared', 'other'])
    await commit([create('b.md', 'shared')])

    const report = await gc(days(400))

    expect(report.versions_removed).toBe(1)
    expect(await versionIds(shared.fileId)).toEqual([shared.versions[1]])
    expect(await t.store.has(shaOf('shared'))).toBe(true)
    expect(await blobRow(shaOf('shared'))).toEqual({ refs: 1 })
    expect(report.blobs_removed).toBe(0)
  })

  it('leaves a blob released within the hour alone', async () => {
    await history('n.md', ['o1', 'o2'])
    // What an in-flight commit looks like: bytes on disk, a row nothing points at yet.
    const now = days(400)
    const fresh = await t.store.put(Buffer.from('fresh'))
    await t.db
      .insertInto('blobs')
      .values({
        sha: fresh.sha,
        size: fresh.size,
        storage_ref: t.store.pathFor(fresh.sha),
        refs: 0,
        created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
        last_referenced_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      })
      .execute()

    const report = await gc(now)

    expect(report.blobs_removed).toBe(1)
    expect(await t.store.has(shaOf('o1'))).toBe(false)
    expect(await t.store.has(fresh.sha)).toBe(true)
    expect(await blobRow(fresh.sha)).toEqual({ refs: 0 })
  })

  it('sweeps uploads a day old and leaves the fresh ones', async () => {
    const now = days(400)
    clock = new Date(now.getTime() - 25 * HOUR_MS)
    const stale = await uploads.begin(shaOf('u1'), 10)
    clock = new Date(now.getTime() - HOUR_MS)
    const live = await uploads.begin(shaOf('u2'), 10)

    const report = await gc(now)

    expect(report.uploads_swept).toBe(1)
    const left = await t.db.selectFrom('uploads').select('id').execute()
    expect(left.map((row) => row.id)).toEqual([live.upload_id])
    expect(left.map((row) => row.id)).not.toContain(stale.upload_id)
  })

  it('sweeps idempotency keys past their ttl and leaves the fresh ones', async () => {
    const now = days(400)
    const row = (key: string, ms: number) => ({
      actor_id: 'device-1',
      key,
      request_hash: 'h',
      status: 200,
      response: '{}',
      created_at: new Date(now.getTime() - ms).toISOString(),
    })
    await t.db
      .insertInto('idempotency')
      .values([row('stale', 25 * HOUR_MS), row('fresh', HOUR_MS)])
      .execute()

    const report = await gc(now)

    expect(report.idempotency_swept).toBe(1)
    const left = await t.db.selectFrom('idempotency').select('key').execute()
    expect(left.map((entry) => entry.key)).toEqual(['fresh'])
  })

  it('refuses a commit that meets a blob being collected, and removes it anyway', async () => {
    await history('n.md', ['gone', 'kept'])
    const sha = shaOf('gone')
    const before = await headSeq()
    let attempt: Promise<{ status: number; body: any }> | undefined
    const store = raceOn(sha, async () => {
      // The collector holds its transaction across deletion. Start a competing
      // request here, without waiting for the lock it is deliberately holding.
      attempt = api(t.app, tok).post(`/v1/vaults/${vaultId}/commit`, {
        ops: [create('race.md', 'gone')],
      })
    })

    const report = await runRetention({
      db: t.db,
      dialect: 'sqlite',
      store,
      uploads,
      idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
      now: () => days(400),
    })

    const answer = await attempt
    expect(answer?.status).toBe(200)
    expect(answer?.body.results[0]).toMatchObject({ status: 'rejected', code: 'not_found' })
    // The batch rolled back whole: no file, no version, no sequence spent.
    const paths = await t.db
      .selectFrom('files')
      .select('path')
      .where('vault_id', '=', vaultId)
      .execute()
    expect(paths.map((row) => row.path)).not.toContain('race.md')
    expect(await headSeq()).toBe(before)
    // And the collection finished: the sha is gone from the disk and from the table.
    expect(report.blobs_removed).toBe(1)
    expect(await t.store.has(sha)).toBe(false)
    expect(await blobRow(sha)).toBeUndefined()
    await everyHeadHasItsBytes()
  })

  it('leaves a blob a commit took between the scan and the claim', async () => {
    // Two blobs fall out of history at once; the sweep takes them in sha order,
    // so removing the first is a moment at which the second is still a candidate.
    await history('a.md', ['orphan one', 'head one'])
    await history('b.md', ['orphan two', 'head two'])
    const [first, second] = [shaOf('orphan one'), shaOf('orphan two')].sort() as [string, string]
    const taken = shaOf('orphan one') === second ? 'orphan one' : 'orphan two'
    // Ownership is proved by upload, not by knowing a digest retention removed.
    await putBlob(taken)
    let landing: Promise<any> | undefined
    const store = raceOn(first, async () => {
      landing = directCommit(
        { db: t.db, store: t.store, hub: t.hub, dialect: 'sqlite', now: () => clock },
        vaultId,
        { kind: 'system', id: 'test', name: 'test' },
        [create('taken.md', taken)]
      )
    })

    const report = await runRetention({
      db: t.db,
      dialect: 'sqlite',
      store,
      uploads,
      idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
      now: () => days(400),
    })

    // The claim on the second sha found a reference and let it be.
    const landed = await landing
    expect(landed.results[0].status).toBe('applied')
    expect(report.blobs_removed).toBe(1)
    expect(await t.store.has(second)).toBe(true)
    expect(await blobRow(second)).toEqual({ refs: 1 })
    expect(await t.store.has(first)).toBe(false)
    await everyHeadHasItsBytes()
  })

  it('leaves a tombstoned row where it is when a version lets it go', async () => {
    const { sha, size } = await t.store.put(Buffer.from('being collected'))
    const iso = BASE.toISOString()
    await t.db
      .insertInto('blobs')
      .values({
        sha,
        size,
        storage_ref: t.store.pathFor(sha),
        refs: -1,
        created_at: iso,
        last_referenced_at: iso,
      })
      .execute()

    await t.db.transaction().execute((trx) => releaseRef(trx, sha))

    expect(await blobRow(sha)).toEqual({ refs: -1 })
  })

  it('carries on through a vault it cannot read, and says so', async () => {
    const { accountToken } = await t.account()
    const broken = (await t.vault(accountToken, 'Broken')).vaultId
    await t.db.updateTable('vaults').set({ settings: '{' }).where('id', '=', broken).execute()
    const { fileId, versions } = await history('n.md', ['v1', 'v2'])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const report = await gc(days(400))
      expect(report.versions_removed).toBe(1)
      expect(await versionIds(fileId)).toEqual([versions[1]])
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]?.[0])).toContain(broken)
    } finally {
      logged.mockRestore()
    }
  })
})
