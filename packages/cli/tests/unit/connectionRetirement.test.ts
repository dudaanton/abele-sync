import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig, stateFolder, readConfig } from '../../src/config.js'
import { activateExternalFiles, assertLocalSafety } from '../../src/externalSafety.js'
import { materializeForDisconnect } from '../../src/externalMaterialization.js'
import {
  retirePreparedConnection,
  resumeConnectionRetirement,
} from '../../src/connectionRetirement.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true })
})
async function fixture() {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'retirement-'))
  roots.push(dir)
  const cfg = {
    serverUrl: 'https://synthetic.example.test',
    vaultId: 'vault',
    deviceId: 'device',
    deviceToken: 'absd_old',
    deviceName: 'synthetic',
    selective: selectiveDefaults(),
  }
  writeConfig(dir, cfg)
  const raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
  const descriptor = await activateExternalFiles(dir, raw, cfg, () => true)
  await raw.setCursor(7)
  raw.setMeta('vault', 'vault')
  raw.close()
  await materializeForDisconnect(
    dir,
    'state.db',
    descriptor.binding,
    { scriptsFolder: 'Scripts', verify: async () => {}, download: async () => new Uint8Array() },
    () => {}
  )
  return { dir, descriptor, cfg }
}
for (const phase of [
  'retirement-written',
  'connection-removed',
  'activation-removed',
  'inventory-retired',
] as const) {
  it(`reopens SQLite and completes safe disconnect cleanup after ${phase}`, async () => {
    const f = await fixture()
    await expect(
      retirePreparedConnection(
        f.dir,
        'state.db',
        f.descriptor.binding,
        () => {},
        (at) => {
          if (at === phase) throw new Error('termination')
        }
      )
    ).rejects.toThrow('termination')
    expect(() => assertLocalSafety(f.dir, true)).toThrow()
    const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(raw.readExternalInstanceId()).toBe(f.descriptor.instanceId)
    raw.close()
    expect(await resumeConnectionRetirement(f.dir, () => {})).toBe(true)
    expect(readConfig(f.dir)).toBeNull()
    expect(() => assertLocalSafety(f.dir, true)).not.toThrow()
    const final = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(final.readExternalInstanceId()).toBe(f.descriptor.instanceId)
    expect(await final.getCursor()).toBe(7)
    expect(await final.getExternalState()).toBeNull()
    final.close()
  })
}
it('refuses changed credentials during retirement recovery instead of deleting a foreign config', async () => {
  const f = await fixture()
  await expect(
    retirePreparedConnection(
      f.dir,
      'state.db',
      f.descriptor.binding,
      () => {},
      () => {
        throw new Error('termination')
      }
    )
  ).rejects.toThrow('termination')
  writeFileSync(join(stateFolder(f.dir), 'config.json'), 'foreign credentials')
  await expect(resumeConnectionRetirement(f.dir, () => {})).rejects.toThrow(/recovery/)
  expect(readFileSync(join(stateFolder(f.dir), 'config.json'), 'utf8')).toBe('foreign credentials')
})
