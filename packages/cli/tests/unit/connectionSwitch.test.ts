import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import SqliteDatabase from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { ExternalState, selectiveDefaults } from '@abele/sync-core'
import { stateFolder, writeConfig, readConfig, personalBinding } from '../../src/config.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { replaceConnection, resumeConnectionSwitch } from '../../src/connectionSwitch.js'
import { activateExternalFiles, assertLocalSafety } from '../../src/externalSafety.js'
import { readConfigDescriptor } from '../../src/config.js'
import { materializeForDisconnect } from '../../src/externalMaterialization.js'
import { runInit } from '../../src/commands/init.js'
import { runRun } from '../../src/commands/run.js'
import { buildTestApp, TEST_PASSWORD } from '@abele/sync-server/tests/helpers/testApp.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
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
it('ordinary run accepts force enrollment from a legacy config with an empty matching external document', async () => {
  const f = fixture(),
    t = await buildTestApp()
  try {
    const email = 'legacy-switch@test.io',
      owner = await t.account(email),
      vault = await t.vault(owner.accountToken),
      device = await t.device(owner.accountToken, vault.vaultId),
      serverUrl = await t.app.listen({ host: '127.0.0.1', port: 0 })
    const old = { ...f.old, serverUrl, vaultId: vault.vaultId, ...device }
    writeConfig(f.dir, old)
    const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    await ExternalState.open(raw, 'legacy-ledger', personalBinding(old))
    raw.close()
    expect(readConfigDescriptor(f.dir)).toBeNull()
    const ctx = { fetch, env: {}, revokeTimeoutMs: 1000, io: { out: vi.fn(), err: vi.fn() } }
    expect(
      await runInit(
        {
          dir: f.dir,
          server: serverUrl,
          email,
          password: TEST_PASSWORD,
          force: true,
          prefer: 'merge',
        },
        ctx
      )
    ).toBe(0)
    expect(await runRun({ dir: f.dir, once: true }, ctx)).toBe(0)
    const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    try {
      expect(reopened.readExternalInstanceId()).toBe(f.instance)
      expect(reopened.getMeta('external-disconnect-ready')).toBeNull()
      const value = await reopened.getExternalState()
      if (value !== null)
        expect(JSON.parse(value).binding).toEqual(personalBinding(readConfig(f.dir)!))
    } finally {
      reopened.close()
    }
  } finally {
    await t.close()
  }
})

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
for (const phase of [
  'credentials-written',
  'credentials-staged',
  'ledger-bound-written',
  'active-connection-written',
  'activation-written',
  'confirmed',
] as const) {
  it(`recovers activated descriptor replacement after ${phase} without a silent rebind`, async () => {
    const f = fixture(),
      revoke = vi.fn(async () => {})
    const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    const descriptor = await activateExternalFiles(f.dir, raw, f.old, () => true)
    await raw.setCursor(7)
    raw.close()
    await materializeForDisconnect(
      f.dir,
      'state.db',
      descriptor.binding,
      { scriptsFolder: 'Scripts', verify: async () => {}, download: async () => new Uint8Array() },
      () => {}
    )
    await expect(
      replaceConnection(
        f.dir,
        f.target,
        true,
        () => {},
        revoke,
        (at) => {
          if (at === phase) throw new Error('termination')
        }
      )
    ).rejects.toThrow('termination')
    expect(revoke).not.toHaveBeenCalled()
    const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(reopened.readExternalInstanceId()).toBe(f.instance)
    reopened.close()
    await resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
    expect(readConfig(f.dir)).toEqual(f.target)
    expect(readConfigDescriptor(f.dir)).toMatchObject({
      instanceId: f.instance,
      binding: personalBinding(f.target, 2),
    })
    const final = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(JSON.parse((await final.getExternalState())!).binding).toEqual(
      personalBinding(f.target, 2)
    )
    expect(await final.getCursor()).toBe(7)
    final.close()
    expect(revoke).toHaveBeenCalledTimes(1)
  })
}
for (const activated of [false, true]) {
  for (const interruption of ['retired', 'inventory-retired', 'cleanup-commit-unknown'] as const) {
    it(`recovers ${activated ? 'activated' : 'legacy'} inventory cleanup after ${interruption} without another revoke`, async () => {
      const f = fixture(),
        revoke = vi.fn(async () => {}),
        file = join(stateFolder(f.dir), 'state.db'),
        raw = SqliteStateStore.open(file)
      if (activated) await activateExternalFiles(f.dir, raw, f.old, () => true)
      else await ExternalState.open(raw, 'legacy-ledger', personalBinding(f.old))
      await raw.setCursor(7)
      raw.close()
      await materializeForDisconnect(
        f.dir,
        'state.db',
        personalBinding(f.old),
        {
          scriptsFolder: 'Scripts',
          verify: async () => {},
          download: async () => new Uint8Array(),
        },
        () => {}
      )
      if (interruption === 'cleanup-commit-unknown') {
        const exec = SqliteDatabase.prototype.exec
        vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(function (
          this: SqliteDatabase.Database,
          sql
        ) {
          const cleanup =
            sql === 'COMMIT' &&
            !this.prepare(
              "SELECT value FROM meta WHERE key = 'daemon:external-disconnect-ready'"
            ).get()
          const result = exec.call(this, sql)
          if (cleanup) throw new Error('lost cleanup acknowledgement')
          return result
        })
      }
      const pending = replaceConnection(
        f.dir,
        f.target,
        true,
        () => {},
        revoke,
        (phase) => {
          if (phase === interruption) throw new Error('termination')
        }
      )
      if (interruption === 'cleanup-commit-unknown')
        await expect(pending).rejects.toMatchObject({ reason: 'commit-unknown' })
      else await expect(pending).rejects.toThrow('termination')
      expect(revoke).toHaveBeenCalledTimes(1)
      expect(() => assertLocalSafety(f.dir)).toThrow()
      vi.restoreAllMocks()
      await resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
      expect(revoke).toHaveBeenCalledTimes(1)
      const final = SqliteStateStore.open(file)
      try {
        expect(final.readExternalInstanceId()).toBe(f.instance)
        expect(await final.getCursor()).toBe(7)
        expect(final.getMeta('external-disconnect-ready')).toBeNull()
        const value = await final.getExternalState()
        if (activated) expect(JSON.parse(value!).binding).toEqual(personalBinding(f.target, 2))
        else {
          expect(value).toBeNull()
          expect(() => assertLocalSafety(f.dir)).not.toThrow()
        }
      } finally {
        final.close()
      }
    })
  }
}

it('a lost activated binding COMMIT acknowledgement stops before config writes or revoke and resolves only after reopen', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {}),
    file = join(stateFolder(f.dir), 'state.db')
  const raw = SqliteStateStore.open(file),
    descriptor = await activateExternalFiles(f.dir, raw, f.old, () => true)
  raw.close()
  await materializeForDisconnect(
    f.dir,
    'state.db',
    descriptor.binding,
    { scriptsFolder: 'Scripts', verify: async () => {}, download: async () => new Uint8Array() },
    () => {}
  )
  const exec = SqliteDatabase.prototype.exec
  vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(function (
    this: SqliteDatabase.Database,
    sql
  ) {
    const result = exec.call(this, sql)
    if (sql === 'COMMIT') throw new Error('lost acknowledgement')
    return result
  })
  await expect(replaceConnection(f.dir, f.target, true, () => {}, revoke)).rejects.toMatchObject({
    reason: 'commit-unknown',
  })
  expect(readConfig(f.dir)).toEqual(f.old)
  expect(revoke).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  const reopened = SqliteStateStore.open(file)
  expect(JSON.parse((await reopened.getExternalState())!).binding).toEqual(
    personalBinding(f.target, 2)
  )
  reopened.close()
  await resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
  expect(readConfig(f.dir)).toEqual(f.target)
  expect(revoke).toHaveBeenCalledTimes(1)
})
it('an activated cross-endpoint switch preserves physical identity but clears foreign entries and progress', async () => {
  const f = fixture(),
    file = join(stateFolder(f.dir), 'state.db'),
    raw = SqliteStateStore.open(file)
  const descriptor = await activateExternalFiles(f.dir, raw, f.old, () => true)
  await raw.setCursor(7)
  await raw.put({
    fileId: 'ordinary',
    path: 'ordinary.bin',
    wirePath: 'ordinary.bin',
    versionId: 'version',
    sha: 'a'.repeat(64),
    size: 1,
    mtime: 1,
  })
  raw.close()
  await materializeForDisconnect(
    f.dir,
    'state.db',
    descriptor.binding,
    { scriptsFolder: 'Scripts', verify: async () => {}, download: async () => new Uint8Array() },
    () => {}
  )
  const target = { ...f.target, serverUrl: 'https://other.example.test' }
  await replaceConnection(
    f.dir,
    target,
    true,
    () => {},
    async () => {}
  )
  const final = SqliteStateStore.open(file)
  expect(final.readExternalInstanceId()).toBe(f.instance)
  expect(await final.getCursor()).toBe(0)
  expect(await final.byFileId('ordinary')).toBeNull()
  expect(JSON.parse((await final.getExternalState())!).binding).toEqual(personalBinding(target, 2))
  final.close()
})
it('malformed staged binding evidence is held before changing the actual SQLite binding', async () => {
  const f = fixture(),
    revoke = vi.fn(async () => {}),
    file = join(stateFolder(f.dir), 'state.db')
  const raw = SqliteStateStore.open(file),
    descriptor = await activateExternalFiles(f.dir, raw, f.old, () => true)
  raw.close()
  await materializeForDisconnect(
    f.dir,
    'state.db',
    descriptor.binding,
    { scriptsFolder: 'Scripts', verify: async () => {}, download: async () => new Uint8Array() },
    () => {}
  )
  await expect(
    replaceConnection(
      f.dir,
      f.target,
      true,
      () => {},
      revoke,
      (at) => {
        if (at === 'credentials-staged') throw new Error('termination')
      }
    )
  ).rejects.toThrow('termination')
  const stage = join(stateFolder(f.dir), 'external-switch-credentials.json'),
    marker = join(stateFolder(f.dir), 'external-connection-switch.json')
  const credentials = JSON.parse(readFileSync(stage, 'utf8')),
    record = JSON.parse(readFileSync(marker, 'utf8'))
  credentials.plan.external.targetBinding.unexpected = 'corrupt'
  record.external = credentials.plan.external
  writeFileSync(stage, JSON.stringify(credentials))
  record.credentialsSha = createHash('sha256').update(readFileSync(stage)).digest('hex')
  writeFileSync(marker, JSON.stringify(record))
  const db = new SqliteDatabase(file, { readonly: true }),
    before = db.prepare("SELECT value FROM meta WHERE key = 'daemon:external-files'").get()
  db.close()
  await expect(
    resumeConnectionSwitch(f.dir, f.target.serverUrl, () => {}, revoke)
  ).rejects.toThrow()
  const reopened = new SqliteDatabase(file, { readonly: true })
  expect(
    reopened.prepare("SELECT value FROM meta WHERE key = 'daemon:external-files'").get()
  ).toEqual(before)
  reopened.close()
  expect(readConfig(f.dir)).toEqual(f.old)
  expect(revoke).not.toHaveBeenCalled()
})
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
