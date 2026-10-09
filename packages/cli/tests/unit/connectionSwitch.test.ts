import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExternalState, selectiveDefaults } from '@abele/sync-core'
import { stateFolder, writeConfig, readConfig, personalBinding } from '../../src/config.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { replaceConnection, resumeConnectionSwitch } from '../../src/connectionSwitch.js'
import { assertLocalSafety } from '../../src/externalSafety.js'

const roots: string[] = []
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'switch-'))
  roots.push(dir)
  const old = {
    serverUrl: 'https://old.example.test',
    vaultId: 'vault',
    deviceId: 'old',
    deviceToken: 'absd_old',
    deviceName: 'old',
    selective: selectiveDefaults(),
  }
  const target = { ...old, deviceId: 'target', deviceToken: 'absd_target' }
  writeConfig(dir, old)
  const state = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
  const instance = state.getExternalInstanceId()
  state.close()
  return { dir, old, target, instance }
}
for (const phase of [
  'credentials-written',
  'prepared',
  'credentials-staged',
  'ledger-retired',
  'active-connection-written',
  'connection-written',
  'confirmed',
] as const) {
  it(`reopens real SQLite and resumes after ${phase} without an empty bootstrap`, async () => {
    const f = fixture(),
      revoke = vi.fn(async () => {})
    await expect(
      replaceConnection(
        f.dir,
        f.target,
        true,
        () => {},
        revoke,
        (written) => {
          if (written === phase) throw new Error('simulated termination')
        }
      )
    ).rejects.toThrow('simulated termination')
    expect(revoke).not.toHaveBeenCalled()
    expect(() => assertLocalSafety(f.dir, true)).toThrow()
    const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(reopened.readExternalInstanceId()).toBe(f.instance)
    reopened.close()
    await resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
    expect(readConfig(f.dir)).toEqual(f.target)
    expect(revoke).toHaveBeenCalledWith(f.old, expect.any(Function))
    expect(() => assertLocalSafety(f.dir, true)).not.toThrow()
    const final = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(final.readExternalInstanceId()).toBe(f.instance)
    final.close()
  })
}
it('does not retain a ledger for the same vault ID on another endpoint', async () => {
  const f = fixture()
  await replaceConnection(
    f.dir,
    { ...f.target, serverUrl: 'https://other.example.test' },
    true,
    () => {},
    async () => {}
  )
  const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
  expect(reopened.readExternalInstanceId()).not.toBe(f.instance)
  reopened.close()
})
it('changed active credentials refuse recovery before revocation', async () => {
  const f = fixture()
  await expect(
    replaceConnection(
      f.dir,
      f.target,
      true,
      () => {},
      async () => {},
      () => {
        throw new Error('stop')
      }
    )
  ).rejects.toThrow('stop')
  writeConfig(f.dir, { ...f.old, deviceToken: 'absd_foreign' })
  const before = readFileSync(join(stateFolder(f.dir), 'config.json')),
    revoke = vi.fn(async () => {})
  await expect(
    resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
  ).rejects.toThrow()
  expect(revoke).not.toHaveBeenCalled()
  expect(readFileSync(join(stateFolder(f.dir), 'config.json'))).toEqual(before)
})

it('resumes retirement acknowledgement without revoking twice', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {})
  await expect(
    replaceConnection(
      f.dir,
      f.target,
      true,
      () => {},
      revoke,
      (phase) => {
        if (phase === 'retired') throw new Error('termination after retirement acknowledgement')
      }
    )
  ).rejects.toThrow('termination after retirement acknowledgement')
  expect(revoke).toHaveBeenCalledTimes(1)
  rmSync(join(stateFolder(f.dir), 'external-switch-credentials.json'))
  await resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
  expect(revoke).toHaveBeenCalledTimes(1)
  expect(readConfig(f.dir)).toEqual(f.target)
  expect(() => assertLocalSafety(f.dir, true)).not.toThrow()
})

it('holds changed staging evidence after retirement instead of deleting it', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {})
  await expect(
    replaceConnection(
      f.dir,
      f.target,
      true,
      () => {},
      revoke,
      (phase) => {
        if (phase === 'retired') throw new Error('stop')
      }
    )
  ).rejects.toThrow('stop')
  const stage = join(stateFolder(f.dir), 'external-switch-credentials.json')
  writeFileSync(stage, 'changed recovery evidence')
  await expect(
    resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
  ).rejects.toThrow()
  expect(readFileSync(stage, 'utf8')).toBe('changed recovery evidence')
  expect(revoke).toHaveBeenCalledTimes(1)
})

it('refuses an unexpected replacement SQLite instance before credential installation or revoke', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {})
  await expect(
    replaceConnection(
      f.dir,
      f.target,
      true,
      () => {},
      revoke,
      (phase) => {
        if (phase === 'credentials-staged') throw new Error('stop')
      }
    )
  ).rejects.toThrow('stop')
  rmSync(join(stateFolder(f.dir), 'state.db'))
  const replaced = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
  replaced.getExternalInstanceId()
  replaced.close()
  await expect(
    resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
  ).rejects.toThrow()
  expect(readConfig(f.dir)).toEqual(f.old)
  expect(revoke).not.toHaveBeenCalled()
})

for (const blocker of [
  'offline',
  'no-space',
  'version-changed',
  'approval-required',
  'access-revoked',
]) {
  for (const availability of ['active', 'deleted', 'unavailable'] as const) {
    it(`preserves the connection and reopened ${availability} inventory for ${blocker}`, async () => {
      const f = fixture(),
        revoke = vi.fn(async () => {})
      const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
      const binding = personalBinding(f.old)
      const external = await ExternalState.open(raw, 'ledger', binding)
      await external.commit({
        expectedRevision: 0,
        files: [
          {
            expectedRevision: null,
            next: {
              schema: 1,
              ledgerId: 'ledger',
              binding,
              fileId: 'file',
              representation: 'remote-only',
              preference: 'on-demand',
              pinned: false,
              projectionPath: 'Media/a.bin.abele-ref',
              projectionSha: 'a'.repeat(64),
              localRevision: 0,
              pendingOperationId: null,
              availability,
              blockingReason: blocker,
              lastProvenLocalBase: null,
              retained: [],
            },
          },
        ],
      })
      raw.close()
      const before = readFileSync(join(stateFolder(f.dir), 'config.json'))
      await expect(replaceConnection(f.dir, f.target, true, () => {}, revoke)).rejects.toThrow(
        blocker
      )
      expect(revoke).not.toHaveBeenCalled()
      expect(readFileSync(join(stateFolder(f.dir), 'config.json'))).toEqual(before)
      const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
      try {
        expect(JSON.parse((await reopened.getExternalState())!).files[0]).toMatchObject({
          availability,
          blockingReason: blocker,
        })
      } finally {
        reopened.close()
      }
    })
  }
}
