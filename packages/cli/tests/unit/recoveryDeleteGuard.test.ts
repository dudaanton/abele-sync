import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ExpectedWrites, pull, readHeldDeletes, selectiveDefaults, SyncClient } from '@abele/sync-core'
import { buildTestApp } from '@abele/sync-server/tests/helpers/testApp.js'
import { commit, create, putBlob } from '@abele/sync-server/tests/helpers/ops.js'
import { writeConfig, stateFolder } from '../../src/config.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { runRun } from '../../src/commands/run.js'

it('BUG: nine recovered deletes plus one new delete in a 40-file vault trip the shipped 15-minute guard', async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch'); await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'replay-delete-')), t = await buildTestApp()
  vi.spyOn(NodeFileSystem.prototype, 'sizeStable').mockResolvedValue(true)
  let raw: SqliteStateStore | undefined
  try {
    const owner = await t.account(), vault = (await t.vault(owner.accountToken)).vaultId, device = await t.device(owner.accountToken, vault)
    await putBlob(t.app, device.deviceToken, 'original')
    const seeded = await commit(t.app, device.deviceToken, vault, Array.from({ length: 40 }, (_, n) => create(`file-${n}.txt`, 'original')))
    const endpoint = await t.app.listen({ host: '127.0.0.1', port: 0 })
    writeConfig(dir, { serverUrl: endpoint, vaultId: vault, deviceId: device.deviceId, deviceToken: device.deviceToken, deviceName: 'test', selective: selectiveDefaults() })
    const client = new SyncClient({ baseUrl: endpoint, token: device.deviceToken, fetch }).forVault(vault)
    raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
    await pull(client, new NodeFileSystem(dir), raw, { expected: new ExpectedWrites(), filter: { excluded: () => false }, dirty: new Set() })
    raw.setMeta('vault', vault)
    const ops = seeded.results.slice(0, 9).map((r) => { if (r.status === 'rejected') throw new Error('bad fixture'); return { op: 'delete' as const, file_id: r.file_id, base_version_id: r.version_id } })
    for (let n = 0; n < 10; n++) await unlink(join(dir, `file-${n}.txt`))
    await raw.setJournal({ batchId: 'interrupted-nine', ops, idempotencyKey: 'interrupted-nine', startedAt: new Date().toISOString() })
    // The server accepted it, but the process died before recording results or the recent tally.
    await client.commit(ops, 'interrupted-nine')
    raw.close(); raw = undefined
    expect(await runRun({ dir, once: true }, { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {} } })).toBe(0)
    raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
    const tenth = seeded.results[9]!; if (tenth.status === 'rejected') throw new Error('bad fixture')
    expect(await readHeldDeletes(raw)).toEqual([{ path: 'file-9.txt', fileId: tenth.file_id }])
    expect((await client.manifest(null)).items.some((file) => file.file_id === tenth.file_id)).toBe(true)
    const recent = JSON.parse(raw.getMeta('recent-deletes')!) as [number, number][]
    expect(recent.reduce((sum, [, count]) => sum + count, 0)).toBe(9)
  } finally { raw?.close(); vi.restoreAllMocks(); await t.close(); await rm(dir, { recursive: true, force: true }) }
})
