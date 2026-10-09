import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as nativeFs from 'node:fs/promises'
import SqliteDatabase from 'better-sqlite3'
import { ExternalState, selectiveDefaults, sha256 } from '@abele/sync-core'
import { stateFolder, writeConfig, readConfig, personalBinding } from '../../src/config.js'
import { activateExternalFiles } from '../../src/externalSafety.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { materializeForDisconnect } from '../../src/externalMaterialization.js'
import { runDisconnect } from '../../src/commands/disconnect.js'
import { runInit } from '../../src/commands/init.js'
import type { CommandContext } from '../../src/context.js'

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>()
  return { ...actual, link: vi.fn(actual.link) }
})
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function fixture(availability: 'active' | 'deleted' | 'unavailable' = 'active') {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'materialize-'))
  roots.push(dir)
  const cfg = {
    serverUrl: 'https://old.example.test',
    vaultId: 'vault',
    deviceId: 'old',
    deviceToken: 'absd_old',
    deviceName: 'old',
    selective: selectiveDefaults(),
  }
  writeConfig(dir, cfg)
  const raw = SqliteStateStore.open(join(stateFolder(dir), 'state.db'))
  const descriptor = await activateExternalFiles(dir, raw, cfg, () => true)
  const bytes = new TextEncoder().encode('verified attachment'),
    sha = await sha256(bytes)
  const base = {
    fileId: 'file',
    versionId: 'version',
    path: 'Media/a.bin',
    sha,
    size: bytes.length,
    mtime: 1,
  }
  await raw.put({ ...base, wirePath: base.path })
  mkdirSync(join(dir, 'Media'))
  const projection = JSON.stringify({
    format: 'abele.external',
    schema: 1,
    vaultId: 'vault',
    fileId: 'file',
    path: base.path,
    observedVersionId: base.versionId,
    sha256: sha,
    size: bytes.length,
    mime: 'application/octet-stream',
    mtime: 1,
  })
  writeFileSync(join(dir, 'Media/a.bin.abele-ref'), projection)
  const ext = await ExternalState.open(raw, descriptor.ledgerId, personalBinding(cfg))
  await ext.commit({
    expectedRevision: 0,
    files: [
      {
        expectedRevision: null,
        next: {
          schema: 1,
          ledgerId: descriptor.ledgerId,
          binding: personalBinding(cfg),
          fileId: 'file',
          representation: 'remote-only',
          preference: 'on-demand',
          pinned: false,
          projectionPath: 'Media/a.bin.abele-ref',
          projectionSha: await sha256(new TextEncoder().encode(projection)),
          localRevision: 0,
          pendingOperationId: null,
          availability,
          blockingReason: null,
          lastProvenLocalBase: base,
          retained: [],
        },
      },
    ],
  })
  raw.close()
  const client = {
    verify: vi.fn(async () => {}),
    download: vi.fn(async () => bytes),
    scriptsFolder: 'Scripts',
  }
  return { dir, cfg, bytes, base, client }
}
function contextFor(f: Awaited<ReturnType<typeof fixture>>): CommandContext {
  return {
    io: { out: vi.fn(), err: vi.fn() },
    env: {},
    revokeTimeoutMs: 1000,
    fetch: vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (init?.method === 'DELETE') {
        expect(readFileSync(join(f.dir, f.base.path))).toEqual(Buffer.from(f.bytes))
        expect(existsSync(join(f.dir, 'Media/a.bin.abele-ref'))).toBe(false)
        return new Response(null, { status: 204 })
      }
      if (path.endsWith('/state'))
        return Response.json({
          head_seq: 1,
          settings: {},
          usage: {
            live_bytes: f.bytes.length,
            by_kind: {},
            history_bytes: 0,
            trash_bytes: 0,
            quota_bytes: null,
          },
        })
      if (path.endsWith('/capabilities'))
        return Response.json({
          extension_version: 1,
          projection_schema: 1,
          personal: true,
          scoped: true,
          verification: {
            live_head: true,
            sha256: true,
            actual_size: true,
            authorization_rechecked: true,
          },
          max_file_size: 200 * 1024 * 1024,
        })
      if (path.endsWith('/head'))
        return Response.json({
          file_id: 'file',
          version_id: 'version',
          path: f.base.path,
          kind: 'attachment',
          sha: f.base.sha,
          size: f.bytes.length,
          mtime: 1,
          seq: 1,
        })
      if (path.endsWith('/external/verify'))
        return Response.json({ verified: true, file_id: 'file', ...JSON.parse(String(init?.body)) })
      if (path.endsWith('/versions/version')) return new Response(f.bytes)
      if (path.endsWith('/login'))
        return Response.json({
          account_token: 'abst_synthetic',
          expires_at: '2099-01-01T00:00:00.000Z',
        })
      if (path === '/v1/vaults')
        return Response.json([
          {
            id: 'vault',
            name: 'Vault',
            role: 'owner',
            usage: {
              live_bytes: f.bytes.length,
              by_kind: {},
              history_bytes: 0,
              trash_bytes: 0,
              quota_bytes: null,
            },
          },
        ])
      if (path === '/v1/devices')
        return Response.json({ device_id: 'target', device_token: 'absd_target' })
      throw new Error(`unexpected request ${init?.method} ${path}`)
    }),
  }
}
it('disconnect materializes before the first revoke, even with force', async () => {
  const f = await fixture(),
    ctx = contextFor(f)
  expect(await runDisconnect({ dir: f.dir, force: true }, ctx)).toBe(0)
  expect(readConfig(f.dir)).toBeNull()
  expect(ctx.fetch).toHaveBeenCalled()
})
it('an activated tree can reenroll after a safely completed disconnect without deleting its SQLite identity', async () => {
  const f = await fixture(),
    ctx = contextFor(f)
  await runDisconnect({ dir: f.dir, force: true }, ctx)
  expect(
    await runInit(
      {
        dir: f.dir,
        server: f.cfg.serverUrl,
        email: 'a@example.test',
        password: 'synthetic',
        force: true,
        prefer: 'merge',
      },
      ctx
    )
  ).toBe(0)
  expect(readConfig(f.dir)?.deviceId).toBe('target')
  expect(readFileSync(join(f.dir, f.base.path))).toEqual(Buffer.from(f.bytes))
})
it('force enrollment prepares the old connection before login, replacement or old-device revoke', async () => {
  const f = await fixture(),
    ctx = contextFor(f)
  expect(
    await runInit(
      {
        dir: f.dir,
        server: f.cfg.serverUrl,
        email: 'a@example.test',
        password: 'synthetic',
        force: true,
        prefer: 'merge',
      },
      ctx
    )
  ).toBe(0)
  expect(readConfig(f.dir)?.deviceId).toBe('target')
  const calls = vi.mocked(ctx.fetch).mock.calls.map(([url]) => String(url))
  expect(calls.findIndex((url) => url.endsWith('/versions/version'))).toBeLessThan(
    calls.findIndex((url) => url.endsWith('/login'))
  )
})
it('materializes through native no-clobber installation before resolving the durable inventory', async () => {
  const f = await fixture()
  await materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  expect(readFileSync(join(f.dir, f.base.path))).toEqual(Buffer.from(f.bytes))
  expect(existsSync(join(f.dir, 'Media/a.bin.abele-ref'))).toBe(false)
  expect(readConfig(f.dir)).toEqual(f.cfg)
  const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
  expect(JSON.parse((await reopened.getExternalState())!).files).toEqual([])
  expect(reopened.getMeta('external-disconnect-ready')).not.toBeNull()
  reopened.close()
})
for (const phase of [
  'download-intent',
  'staging-written',
  'ready-to-install',
  'installed',
  'hydrated',
  'projection-removed',
  'ready',
] as const) {
  it(`recovers materialization after ${phase} with a real SQLite reopen`, async () => {
    const f = await fixture()
    await expect(
      materializeForDisconnect(
        f.dir,
        'state.db',
        personalBinding(f.cfg),
        f.client,
        () => {},
        (at) => {
          if (at === phase) throw new Error('termination')
        }
      )
    ).rejects.toThrow('termination')
    const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(JSON.parse((await reopened.getExternalState())!).binding).toEqual(personalBinding(f.cfg))
    reopened.close()
    await materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
    expect(readFileSync(join(f.dir, f.base.path))).toEqual(Buffer.from(f.bytes))
    expect(existsSync(join(f.dir, 'Media/a.bin.abele-ref'))).toBe(false)
  })
}
for (const failure of [
  'offline',
  'no-space',
  'version-changed',
  'approval-required',
  'access-revoked',
]) {
  it(`preserves credentials and inventory on ${failure}`, async () => {
    const f = await fixture(),
      before = readFileSync(join(stateFolder(f.dir), 'config.json'))
    f.client.verify.mockRejectedValue(new Error(failure))
    await expect(
      materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
    ).rejects.toThrow(failure)
    expect(readFileSync(join(stateFolder(f.dir), 'config.json'))).toEqual(before)
    const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
    expect(JSON.parse((await raw.getExternalState())!).files[0].representation).toBe('remote-only')
    raw.close()
  })
}
it('rescues an authorized deleted historical version without Restore or live-head substitution', async () => {
  const f = await fixture('deleted')
  await materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  expect(f.client.verify).not.toHaveBeenCalled()
  expect(f.client.download).toHaveBeenCalledWith(f.base, expect.any(Function))
})
it('retains revoked inventory and never attempts a personal fallback', async () => {
  const f = await fixture('unavailable')
  await expect(
    materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  ).rejects.toThrow(/unavailable/)
  expect(f.client.download).not.toHaveBeenCalled()
})
for (const when of ['before', 'during', 'restart'] as const) {
  it(`preserves an occupied target created ${when} installation, even for equal bytes`, async () => {
    const f = await fixture(),
      target = join(f.dir, f.base.path)
    if (when === 'before') writeFileSync(target, f.bytes)
    if (when === 'restart') {
      await expect(
        materializeForDisconnect(
          f.dir,
          'state.db',
          personalBinding(f.cfg),
          f.client,
          () => {},
          (at) => {
            if (at === 'ready-to-install') throw new Error('stop')
          }
        )
      ).rejects.toThrow('stop')
      writeFileSync(target, f.bytes)
    }
    await expect(
      materializeForDisconnect(
        f.dir,
        'state.db',
        personalBinding(f.cfg),
        f.client,
        () => {},
        (at) => {
          if (when === 'during' && at === 'ready-to-install') writeFileSync(target, f.bytes)
        }
      )
    ).rejects.toThrow(/collision/)
    expect(readFileSync(target)).toEqual(Buffer.from(f.bytes))
    expect(existsSync(join(f.dir, 'Media/a.bin.abele-ref'))).toBe(true)
  })
}
it('rechecks the physical ledger between later verification HTTP requests', async () => {
  const f = await fixture(),
    ctx = contextFor(f),
    fetch = ctx.fetch,
    calls: string[] = []
  ctx.fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    const response = await fetch(input, init)
    if (path.endsWith('/capabilities')) {
      const file = join(stateFolder(f.dir), 'state.db')
      renameSync(file, file + '.retained')
      const replaced = SqliteStateStore.open(file)
      replaced.getExternalInstanceId()
      replaced.close()
    }
    return response
  })
  await expect(runDisconnect({ dir: f.dir, force: true }, ctx)).rejects.toThrow(/physical ledger/)
  expect(calls.some((path) => path.endsWith('/external/verify'))).toBe(false)
  expect(existsSync(join(f.dir, f.base.path))).toBe(false)
  expect(readConfig(f.dir)).toEqual(f.cfg)
})
it('retains verified staging and the active connection when native link reports ENOSPC', async () => {
  const f = await fixture(),
    before = readFileSync(join(stateFolder(f.dir), 'config.json'))
  vi.mocked(nativeFs.link).mockRejectedValueOnce(
    Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  )
  await expect(
    materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  ).rejects.toThrow(/no-space/)
  expect(readFileSync(join(stateFolder(f.dir), 'config.json'))).toEqual(before)
  const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
  const doc = JSON.parse((await raw.getExternalState())!)
  expect(doc.files[0].representation).toBe('remote-only')
  expect(doc.operations[0].phase).toBe('ready-to-install')
  expect(existsSync(join(f.dir, doc.operations[0].sourcePath))).toBe(true)
  raw.close()
})
it('keeps the ledger physical Unicode spelling separate from the version-bound wire path', async () => {
  const f = await fixture(),
    physical = 'Me\u0301dia/a.bin',
    wire = physical.normalize('NFC')
  renameSync(join(f.dir, 'Media'), join(f.dir, 'Me\u0301dia'))
  f.base.path = wire
  const raw = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db'))
  await raw.put({ ...f.base, path: physical, wirePath: wire })
  const ext = await ExternalState.open(
      raw,
      JSON.parse((await raw.getExternalState())!).ledgerId,
      personalBinding(f.cfg)
    ),
    doc = await ext.snapshot()
  const projectionPath = physical + '.abele-ref',
    bytes = new TextEncoder().encode(
      JSON.stringify({
        format: 'abele.external',
        schema: 1,
        vaultId: 'vault',
        fileId: 'file',
        path: wire,
        observedVersionId: 'version',
        sha256: f.base.sha,
        size: f.base.size,
        mime: 'application/octet-stream',
        mtime: 1,
      })
    )
  writeFileSync(join(f.dir, projectionPath), bytes)
  await ext.commit({
    expectedRevision: doc.revision,
    files: [
      {
        expectedRevision: 0,
        next: {
          ...doc.files[0]!,
          projectionPath,
          projectionSha: await sha256(bytes),
          lastProvenLocalBase: f.base,
          localRevision: 1,
        },
      },
    ],
  })
  raw.close()
  await expect(
    materializeForDisconnect(
      f.dir,
      'state.db',
      personalBinding(f.cfg),
      f.client,
      () => {},
      (at) => {
        if (at === 'ready-to-install') throw new Error('termination')
      }
    )
  ).rejects.toThrow('termination')
  const reopened = SqliteStateStore.open(join(stateFolder(f.dir), 'state.db')),
    operation = JSON.parse((await reopened.getExternalState())!).operations[0]
  expect(operation.expected.path).toBe(wire)
  expect(operation.targetPath).toBe(physical)
  reopened.close()
  await materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  expect(readFileSync(join(f.dir, physical))).toEqual(Buffer.from(f.bytes))
})
it('orphan disconnect staging remains an inventory hold rather than being discarded by force', async () => {
  const f = await fixture()
  mkdirSync(join(stateFolder(f.dir), 'disconnect-staging'))
  const orphan = join(stateFolder(f.dir), 'disconnect-staging', 'unrecorded')
  writeFileSync(orphan, 'retained recovery bytes')
  await expect(
    materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  ).rejects.toThrow(/staging/)
  expect(readFileSync(orphan, 'utf8')).toBe('retained recovery bytes')
  expect(readConfig(f.dir)).toEqual(f.cfg)
})
it('an unknown COMMIT cannot authorize filesystem work until a real reopen confirms the phase', async () => {
  const f = await fixture(),
    exec = SqliteDatabase.prototype.exec
  vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(function (
    this: SqliteDatabase.Database,
    sql
  ) {
    const result = exec.call(this, sql)
    if (sql === 'COMMIT') throw new Error('lost acknowledgement')
    return result
  })
  await expect(
    materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  ).rejects.toMatchObject({ reason: 'commit-unknown' })
  expect(f.client.download).not.toHaveBeenCalled()
  expect(existsSync(join(f.dir, f.base.path))).toBe(false)
  vi.restoreAllMocks()
  await materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  expect(readFileSync(join(f.dir, f.base.path))).toEqual(Buffer.from(f.bytes))
})
it('force cannot revoke or replace a changed materialized original after preparation', async () => {
  const f = await fixture(),
    ctx = contextFor(f)
  await materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  writeFileSync(join(f.dir, f.base.path), 'new local edit')
  await expect(runDisconnect({ dir: f.dir, force: true }, ctx)).rejects.toThrow(/local-changed/)
  await expect(
    runInit(
      {
        dir: f.dir,
        server: f.cfg.serverUrl,
        email: 'a@example.test',
        password: 'synthetic',
        force: true,
      },
      ctx
    )
  ).rejects.toThrow(/local-changed/)
  expect(ctx.fetch).not.toHaveBeenCalled()
  expect(readConfig(f.dir)).toEqual(f.cfg)
})
it('holds changed projections and digest/size mismatches instead of clearing dependencies', async () => {
  const f = await fixture()
  writeFileSync(join(f.dir, 'Media/a.bin.abele-ref'), 'user edit')
  await expect(
    materializeForDisconnect(f.dir, 'state.db', personalBinding(f.cfg), f.client, () => {})
  ).rejects.toThrow(/projection/)
  expect(readFileSync(join(f.dir, 'Media/a.bin.abele-ref'), 'utf8')).toBe('user edit')
  const g = await fixture()
  g.client.download.mockResolvedValue(new Uint8Array([1]))
  await expect(
    materializeForDisconnect(g.dir, 'state.db', personalBinding(g.cfg), g.client, () => {})
  ).rejects.toThrow(/version-changed/)
  expect(existsSync(join(g.dir, g.base.path))).toBe(false)
})
