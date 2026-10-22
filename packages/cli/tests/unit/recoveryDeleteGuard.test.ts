import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { readHeldDeletes, selectiveDefaults, V2EngineClient } from '@abele/sync-core'
import { createHash } from 'node:crypto'
import type { CommitOpResult } from '@abele/sync-protocol'
import { v2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { writeConfig, stateFolder } from '../../src/config.js'
import { NodeFileSystem } from '@abele/sync-node'
import { SqliteStateStore } from '@abele/sync-node'
import { runRun } from '../../src/commands/run.js'

it('BUG: nine recovered deletes plus one new delete in a 40-file vault trip the shipped 15-minute guard', async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'replay-delete-')),
    t = await v2Server()
  vi.spyOn(NodeFileSystem.prototype, 'sizeStable').mockResolvedValue(true)
  let raw: SqliteStateStore | undefined
  try {
    const root = await createUser(
      { db: t.db, pepper: t.config.tokenPepper, dialect: 'sqlite' },
      'Delete recovery',
      t.address
    )
    const client = new V2EngineClient(root.token, { fetch })
    const sha = createHash('sha256').update('original').digest('hex')
    await client.putBlob(sha, new TextEncoder().encode('original'))
    const seeded = await client.commit(
      Array.from({ length: 40 }, (_, n) => ({
        op: 'create' as const,
        path: `file-${n}.txt`,
        kind: 'attachment' as const,
        sha,
        size: 8,
        mtime: 1,
      })),
      'seed'
    )
    const info = await client.connection()
    const endpoint = t.address
    writeConfig(dir, {
      serverUrl: endpoint,
      vaultId: info.space_id,
      deviceId: info.token_id,
      deviceToken: root.token,
      deviceName: 'test',
      selective: selectiveDefaults(),
    })
    let downloads = 0
    const transport: typeof fetch = (input, init) => {
      if (new URL(String(input)).pathname.endsWith('/content')) downloads++
      return fetch(input, init)
    }
    const context = {
      fetch: transport,
      env: {},
      revokeTimeoutMs: 20,
      io: { out: () => {}, err: () => {} },
    }
    // This regression starts from a synced 40-file inventory. Adopt its existing
    // bytes through the real CLI instead of doing 40 unrelated durable downloads.
    for (let n = 0; n < 40; n++) await writeFile(join(dir, `file-${n}.txt`), 'original')
    expect(await runRun({ dir, once: true }, context)).toBe(0)
    expect(downloads).toBe(0)
    raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
    const ops = seeded.results.slice(0, 9).map((r: CommitOpResult) => {
      if (r.status === 'rejected') throw new Error('bad fixture')
      return { op: 'delete' as const, file_id: r.file_id, base_version_id: r.version_id }
    })
    for (let n = 0; n < 10; n++) await unlink(join(dir, `file-${n}.txt`))
    await raw.setJournal({
      batchId: 'interrupted-nine',
      ops,
      idempotencyKey: 'interrupted-nine',
      startedAt: new Date().toISOString(),
    })
    // The server accepted it, but the process died before recording results or the recent tally.
    await client.commit(ops, 'interrupted-nine')
    raw.close()
    raw = undefined
    expect(
      await runRun(
        { dir, once: true },
        { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {} } }
      )
    ).toBe(0)
    raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
    const tenth = seeded.results[9]!
    if (tenth.status === 'rejected') throw new Error('bad fixture')
    expect(await readHeldDeletes(raw)).toEqual([{ path: 'file-9.txt', fileId: tenth.file_id }])
    expect((await client.manifest(null)).items.some((file) => file.file_id === tenth.file_id)).toBe(
      true
    )
    const recent = JSON.parse(raw.getMeta('recent-deletes')!) as [number, number][]
    expect(recent.reduce((sum, [, count]) => sum + count, 0)).toBe(9)
  } finally {
    raw?.close()
    vi.restoreAllMocks()
    await t.close()
    await rm(dir, { recursive: true, force: true })
  }
})
