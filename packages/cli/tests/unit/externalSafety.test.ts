import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalState, selectiveDefaults } from '@abele/sync-core'
import { writeConfig, stateFolder, personalBinding, type DaemonConfig } from '../../src/config.js'
import { tokenFor } from '../helpers/token.js'
import { SqliteStateStore } from '@abele/sync-node'
import { runRun } from '../../src/commands/run.js'
import { runConnect } from '../../src/commands/connect.js'
import { runDisconnect } from '../../src/commands/disconnect.js'
import { runRestore } from '../../src/commands/restore.js'
import { runCode } from '../../src/commands/code.js'
import { runDeletes } from '../../src/commands/deletes.js'
import { acquireLock } from '@abele/sync-node'
import { assertLocalSafety } from '@abele/sync-node'
import type { CommandContext } from '../../src/context.js'

let dir: string
const cfg: DaemonConfig = {
  serverUrl: 'https://synthetic.example.test',
  vaultId: 'vault',
  deviceId: 'device',
  deviceToken: tokenFor('https://synthetic.example.test'),
  deviceName: 'synthetic',
  selective: selectiveDefaults(),
}
const binding = personalBinding(cfg)
const dbFile = () => join(stateFolder(dir), 'state.db')
function context(): CommandContext {
  return {
    io: { out: vi.fn(), err: vi.fn() },
    env: {},
    revokeTimeoutMs: 20,
    fetch: vi.fn(async () => {
      throw new Error('network must not run before recovery')
    }),
  }
}
beforeEach(async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  dir = await mkdtemp(join(scratch, 'external-safety-'))
  writeConfig(dir, cfg)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
async function dependency(
  availability: 'active' | 'deleted' | 'detached' | 'unavailable' = 'active',
  blockingReason = 'recovery required'
) {
  const raw = SqliteStateStore.open(dbFile())
  try {
    const state = await ExternalState.open(raw, 'ledger', binding)
    await state.commit({
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
            projectionPath: 'Media/a.jpg.abele-ref',
            projectionSha: 'b'.repeat(64),
            localRevision: 0,
            pendingOperationId: null,
            availability,
            blockingReason,
            lastProvenLocalBase: null,
            retained: [],
          },
        },
      ],
    })
  } finally {
    raw.close()
  }
}
const commands = {
  run: (ctx: CommandContext) => runRun({ dir, once: true }, ctx),
  connect: (ctx: CommandContext) => runConnect({ dir, token: cfg.deviceToken }, ctx),
  disconnect: (ctx: CommandContext) => runDisconnect({ dir }, ctx),
  restore: (ctx: CommandContext) => runRestore('Media/a.jpg', { dir, version: 'version' }, ctx),
  restoreMany: (ctx: CommandContext) =>
    runRestore(undefined, { dir, deletedSince: '2h', yes: true }, ctx),
  approve: (ctx: CommandContext) => runCode({ dir, approve: ['sample'], expect: 'sample' }, ctx),
  reject: (ctx: CommandContext) => runCode({ dir, reject: ['sample'], expect: 'sample' }, ctx),
  deletes: (ctx: CommandContext) => runDeletes({ dir, confirm: true, expect: 'sample' }, ctx),
}
describe('initial CLI recovery and lifecycle holds', () => {
  for (const [name, run] of Object.entries(commands))
    it(`BUG: ${name} cannot mutate/replay/revoke/replace before external recovery`, async () => {
      await dependency()
      const ctx = context(),
        before = readFileSync(join(stateFolder(dir), 'config.json'))
      await expect(run(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
      expect(ctx.fetch).not.toHaveBeenCalled()
      expect(readFileSync(join(stateFolder(dir), 'config.json'))).toEqual(before)
      expect(existsSync(dbFile())).toBe(true)
      const state = SqliteStateStore.open(dbFile())
      try {
        expect(JSON.parse((await state.getExternalState())!).files).toHaveLength(1)
      } finally {
        state.close()
      }
    })
  for (const blocker of [
    'offline',
    'no-space',
    'version-changed',
    'approval-required',
    'access-revoked',
    'unavailable',
  ])
    it(`preserves config, token and retained bytes for ${blocker} retirement holds`, async () => {
      await dependency('active', blocker)
      expect(() => assertLocalSafety(dir, true)).toThrow(blocker)
      await writeFile(join(dir, 'retained.bin'), 'retained content')
      const before = readFileSync(join(stateFolder(dir), 'config.json')),
        ctx = context()
      await expect(commands.disconnect(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
      await expect(commands.disconnect(ctx)).rejects.toThrow(blocker)
      expect(ctx.fetch).not.toHaveBeenCalled()
      expect(readFileSync(join(stateFolder(dir), 'config.json'))).toEqual(before)
      expect(readFileSync(join(dir, 'retained.bin'), 'utf8')).toBe('retained content')
      const reopened = SqliteStateStore.open(dbFile())
      try {
        expect(JSON.parse((await reopened.getExternalState())!).files[0].blockingReason).toBe(
          blocker
        )
      } finally {
        reopened.close()
      }
    })
  for (const availability of ['deleted', 'detached', 'unavailable'] as const)
    it(`BUG: ${availability} dependencies cannot be retired even with force`, async () => {
      await dependency(availability)
      await expect(runDisconnect({ dir }, context())).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      expect(existsSync(join(stateFolder(dir), 'config.json'))).toBe(true)
    })
  for (const evidence of [
    'external-activation.json',
    'external-connection-switch.json',
    'renamed-projection',
    'oversized-prefix-projection',
    'oversized-damaged-prefix-projection',
    'oversized-escaped-prefix-projection',
    'oversized-truncated-prefix-projection',
  ] as const)
    it(`missing ledger with ${evidence} cannot bootstrap or force re-enroll`, async () => {
      if (evidence.endsWith('.json'))
        await writeFile(join(stateFolder(dir), evidence), '{retained evidence')
      else
        await writeFile(
          join(dir, 'renamed.bin'),
          evidence === 'oversized-prefix-projection'
            ? JSON.stringify({
                format: 'abele.external',
                schema: 1,
                fileId: 'foreign',
                padding: 'x'.repeat(20 * 1024),
              })
            : evidence === 'oversized-damaged-prefix-projection'
              ? '{"format":"abele.external", broken' + ' '.repeat(20 * 1024)
              : evidence === 'oversized-escaped-prefix-projection'
                ? '{"\\u0066ormat":"abele\\u002eexternal", broken' + ' '.repeat(20 * 1024)
                : evidence === 'oversized-truncated-prefix-projection'
                  ? '{"format":"abele.external' + ' '.repeat(20 * 1024)
                  : JSON.stringify({ format: 'abele.external', schema: 1, fileId: 'foreign' })
        )
      const ctx = context()
      await expect(commands.run(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
      await expect(commands.connect(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
      expect(ctx.fetch).not.toHaveBeenCalled()
      expect(existsSync(dbFile())).toBe(false)
    })
  it('BUG: a corrupt publication journal blocks engine construction and replay', async () => {
    const state = SqliteStateStore.open(dbFile())
    state.close()
    const Db = (await import('better-sqlite3')).default
    const raw = new Db(dbFile())
    raw
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
      .run('journal', JSON.stringify({ bogus: true }))
    raw.close()
    const ctx = context()
    await expect(commands.run(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
    expect(ctx.fetch).not.toHaveBeenCalled()
  })
  for (const key of ['deferred-changes', 'pull-write:file'])
    it(`BUG: ${key} dependencies are not bypassed by force retirement`, async () => {
      const state = SqliteStateStore.open(dbFile())
      const value =
        key === 'deferred-changes'
          ? {
              staged: [
                {
                  change: {
                    seq: 1,
                    file_id: 'file',
                    op: 'modify',
                    path: 'Media/a.jpg',
                    prev_path: null,
                    sha: 'a'.repeat(64),
                    size: 10,
                    mtime: 1,
                    version_id: 'version',
                    kind: 'attachment',
                    actor: { kind: 'device', id: 'other', name: 'other' },
                    at: '2030-01-01T00:00:00.000Z',
                  },
                  base: 'base',
                },
              ],
            }
          : {
              fileId: 'file',
              versionId: 'version',
              target: 'Media/a.jpg',
              wirePath: 'Media/a.jpg',
              from: null,
              base: null,
            }
      state.setMeta(key, JSON.stringify(value))
      state.close()
      const ctx = context()
      await expect(commands.disconnect(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
      expect(ctx.fetch).not.toHaveBeenCalled()
      expect(existsSync(join(stateFolder(dir), 'config.json'))).toBe(true)
    })
  it('BUG: retained/staging bytes are not discarded by force retirement', async () => {
    await mkdir(join(stateFolder(dir), 'tmp'), { recursive: true })
    await writeFile(join(stateFolder(dir), 'tmp', 'incoming'), 'retained bytes')
    await expect(commands.disconnect(context())).rejects.toMatchObject({
      reason: 'recovery-required',
    })
    expect(readFileSync(join(stateFolder(dir), 'tmp', 'incoming'), 'utf8')).toBe('retained bytes')
  })
  it('BUG: orphaned disconnect staging bytes block startup and retirement without deletion', async () => {
    const path = join(stateFolder(dir), 'disconnect-staging')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'incoming'), 'retained source')
    const ctx = context()
    await expect(commands.run(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
    await expect(commands.disconnect(ctx)).rejects.toMatchObject({ reason: 'recovery-required' })
    expect(readFileSync(join(path, 'incoming'), 'utf8')).toBe('retained source')
    expect(ctx.fetch).not.toHaveBeenCalled()
  })
  it('retains unjournaled installation bytes for review without blocking every startup', async () => {
    const path = join(stateFolder(dir), 'code-approvals', 'group-interrupted', 'blobs')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'retained'), 'recovery bytes')
    const ctx = context()
    await expect(commands.run(ctx)).rejects.toMatchObject({ code: 'offline' })
    const folder = join(stateFolder(dir), 'code-approvals')
    const reviews = (await readdir(folder)).filter((name) =>
      name.startsWith('review-group-interrupted-')
    )
    expect(reviews).toHaveLength(1)
    expect(readFileSync(join(folder, reviews[0]!, 'blobs', 'retained'), 'utf8')).toBe(
      'recovery bytes'
    )
    expect(ctx.fetch).toHaveBeenCalledTimes(1)
  })
  it('BUG: lock ownership is checked at the effect, not after the next heartbeat', async () => {
    const lock = await acquireLock(dir)
    try {
      writeFileSync(
        join(stateFolder(dir), 'lock'),
        '123456\n' + JSON.stringify({ instance: 'successor' }) + '\n'
      )
      expect(lock.held()).toBe(false)
    } finally {
      lock()
    }
  })
  it('BUG: real SQLite instance identity survives reopening; state effects recheck ownership after awaits', async () => {
    let held = true
    const guard = () => {
      if (!held) throw new Error('sample lost ownership')
    }
    let state = SqliteStateStore.open(dbFile(), { effectGuard: guard })
    const id = state.getExternalInstanceId()
    state.close()
    state = SqliteStateStore.open(dbFile(), { effectGuard: guard })
    try {
      expect(state.getExternalInstanceId()).toBe(id)
      await expect(
        state.transaction(async (tx) => {
          await tx.setMeta!('effect', 'uncommitted')
          await Promise.resolve()
          held = false
        })
      ).rejects.toThrow('sample lost ownership')
    } finally {
      state.close()
    }
    state = SqliteStateStore.open(dbFile())
    try {
      expect(state.getMeta('effect')).toBeNull()
      expect(state.getExternalInstanceId()).toBe(id)
    } finally {
      state.close()
    }
  })
})
