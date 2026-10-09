import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig, stateFolder } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { runRestoreSince } from '../../src/commands/restoreSince.js'
import { runRestore } from '../../src/commands/restore.js'
import { runDeletes } from '../../src/commands/deletes.js'
import { openVault } from '../../src/vault.js'
import type { CommandContext, PromptInput } from '../../src/context.js'

let dir: string
const cfg = { serverUrl: 'https://synthetic.example.test', vaultId: 'vault', deviceId: 'device', deviceToken: 'absd_synthetic', deviceName: 'test', selective: selectiveDefaults() }
beforeEach(async () => { const scratch = resolve(import.meta.dirname, '../../../../.scratch'); await mkdir(scratch, { recursive: true }); dir = await mkdtemp(join(scratch, 'borrowed-fence-')); writeConfig(dir, cfg) })
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) })
const changes = {
  replaced: () => writeConfig(dir, { ...cfg, deviceToken: 'absd_replacement' }),
  disconnected: () => rmSync(join(stateFolder(dir), 'config.json')),
  activation: () => writeFileSync(join(stateFolder(dir), 'external-activation.json'), '{preparing'),
}
describe('bindings and recovery evidence beside a daemon', () => {
  for (const [change, mutate] of Object.entries(changes))
    it(`BUG: bulk Restore waiting for confirmation refuses a ${change} connection before its POST`, async () => {
      const lock = await acquireLock(dir), input = new PassThrough() as PromptInput, output = new PassThrough()
      input.isTTY = true
      const items = Array.from({ length: 21 }, (_, n) => ({ file_id: `file-${n}`, path: `file-${n}.bin`, kind: 'attachment', deleted_at: new Date().toISOString(), last_version_id: `version-${n}`, size: 1 }))
      const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'GET' ? items : {
        head_seq: 1, results: items.map((item) => ({ status: 'applied', file_id: item.file_id, version_id: 'restored', seq: 1, path: item.path, sha: 'a'.repeat(64), size: 1, mtime: 1 })),
      })))
      output.on('data', (chunk: Buffer) => { if (chunk.toString().includes('Restore them?')) { lock(); mutate(); setImmediate(() => input.write('y\n')) } })
      const ctx: CommandContext = { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {}, stdin: input, stderr: output } }
      try {
        await expect(runRestoreSince(dir, { deletedSince: '2h' }, ctx)).rejects.toMatchObject(change === 'activation' ? { reason: 'recovery-required' } : { code: 'lost' })
        expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
      } finally { input.destroy(); output.destroy(); lock() }
    })
  it('BUG: single-file Restore beside a daemon rechecks after its version query', async () => {
    const raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
    await raw.put({ path: 'a.bin', wirePath: 'a.bin', fileId: 'file', versionId: 'current', sha: 'a'.repeat(64), size: 1, mtime: 1 }); raw.close()
    const lock = await acquireLock(dir)
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'GET') { lock(); changes.replaced(); return new Response(JSON.stringify([2, 1].map((n) => ({ version_id: `v${n}`, no: n, seq: n, op: 'modify', path: 'a.bin', sha: 'a'.repeat(64), size: 1, mtime: 1, actor: { kind: 'system', id: 'server', name: 'server' }, at: new Date().toISOString(), merge: null })))) }
      return new Response(JSON.stringify({ status: 'applied', file_id: 'file', version_id: 'restored', seq: 3, path: 'a.bin', sha: 'a'.repeat(64), size: 1, mtime: 1 }))
    })
    try {
      await expect(runRestore('a.bin', { dir }, { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {} } })).rejects.toMatchObject({ code: 'lost' })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { lock() }
  })
  for (const [change, mutate] of Object.entries(changes))
    it(`BUG: delete confirmation beside a daemon cannot file a decision after ${change}`, async () => {
      const file = join(stateFolder(dir), 'state.db'), raw = SqliteStateStore.open(file)
      raw.setMeta('held-deletes', JSON.stringify([{ path: 'a.bin', fileId: 'file' }])); raw.close()
      const lock = await acquireLock(dir), input = new PassThrough() as PromptInput, output = new PassThrough(); input.isTTY = true
      output.on('data', () => { lock(); mutate(); setImmediate(() => input.write('y\n')) })
      try {
        await expect(runDeletes({ dir, confirm: true }, { fetch: vi.fn(), env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {}, stdin: input, stderr: output } })).rejects.toMatchObject(change === 'activation' ? { reason: 'recovery-required' } : { code: 'lost' })
        const inspected = SqliteStateStore.openReadOnlySnapshot(file)
        try { expect(inspected.getMeta('delete-decision')).toBeNull() } finally { inspected.close() }
      } finally { input.destroy(); output.destroy(); lock() }
    })
  it('BUG: a retained non-owning client cannot issue requests after close', async () => {
    const fetch = vi.fn(async () => new Response('{}')), vault = openVault(dir, { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {} } })
    vault.close()
    await expect(vault.client.trash()).rejects.toMatchObject({ code: 'lost' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
