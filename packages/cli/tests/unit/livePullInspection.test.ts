import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { buildTestApp } from '@abele/sync-server/tests/helpers/testApp.js'
import { writeConfig, stateFolder } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { runStatus } from '../../src/commands/status.js'
import { runDeletes } from '../../src/commands/deletes.js'

it('BUG: status and read-only deletes work for the live daemon owner intent, but hold its crash leftover or a different owner', async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'live-pull-')),
    t = await buildTestApp()
  let release: (() => void) | undefined
  try {
    const account = await t.account(),
      vault = (await t.vault(account.accountToken)).vaultId,
      device = await t.device(account.accountToken, vault)
    const endpoint = await t.app.listen({ host: '127.0.0.1', port: 0 })
    writeConfig(dir, {
      serverUrl: endpoint,
      vaultId: vault,
      deviceId: device.deviceId,
      deviceToken: device.deviceToken,
      deviceName: 'test',
      selective: selectiveDefaults(),
    })
    const lock = await acquireLock(dir, { daemon: true })
    release = lock
    const owner = (
      JSON.parse(readFileSync(join(stateFolder(dir), 'lock'), 'utf8').split('\n')[1]!) as {
        instance: string
      }
    ).instance
    const file = join(stateFolder(dir), 'state.db'),
      raw = SqliteStateStore.open(file)
    const intent = {
      fileId: 'file',
      versionId: 'version',
      wirePath: 'a.bin',
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
      target: 'a.bin',
      from: null,
      base: null,
      owner,
    }
    raw.setMeta('pull-write:file', JSON.stringify(intent))
    raw.close()
    const ctx = { fetch, env: {}, revokeTimeoutMs: 20, io: { out: () => {}, err: () => {} } }
    expect(await runStatus({ dir }, ctx)).toBe(0)
    expect(await runDeletes({ dir }, ctx)).toBe(0)
    let inspected = SqliteStateStore.open(file)
    inspected.setMeta('pull-write:file', JSON.stringify({ ...intent, owner: 'dead-predecessor' }))
    inspected.close()
    await expect(runDeletes({ dir }, ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
    inspected = SqliteStateStore.open(file)
    inspected.setMeta('pull-write:file', JSON.stringify(intent))
    inspected.close()
    lock()
    release = undefined
    await expect(runStatus({ dir }, ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
    await expect(runDeletes({ dir }, ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
  } finally {
    release?.()
    await t.close()
    await rm(dir, { recursive: true, force: true })
  }
})
