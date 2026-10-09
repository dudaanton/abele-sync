import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createScopedClient,
  ExternalState,
  ScopedState,
  sha256,
  encodeText,
} from '@abele/sync-core'
import * as Agent from '../../src/agentVault.js'
import {
  writeAgentConfig,
  agentDbFile,
  agentConfigFile,
  readAgentConfig,
  openAgentVault,
} from '../../src/agentVault.js'
import { acquireLock } from '../../src/lock.js'
import { runAgentDisconnect, runAgentRestore } from '../../src/commands/agentMaintenance.js'
import { runAgentRun, runAgentSetup } from '../../src/commands/agent.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import type { CommandContext } from '../../src/context.js'
const roots: string[] = []
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})
async function fixture(withDependency = true) {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'agent-hold-'))
  roots.push(dir)
  const token = 'absk_' + 'a'.repeat(43),
    fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('must not reach network before recovery')
    })
  const ctx: CommandContext = {
    fetch,
    env: { ABELE_AGENT_TOKEN: token },
    revokeTimeoutMs: 20,
    io: { out: vi.fn(), err: vi.fn() },
  }
  const client = await createScopedClient({
    baseUrl: 'https://synthetic.example.test',
    fetch,
    token,
    vaultId: 'vault',
    grantId: 'grant',
    principalId: 'key',
    principalKind: 'key',
  })
  writeAgentConfig(dir, { mode: 'agent', scriptPolicy: 'refuse', binding: client.binding, token })
  const raw = SqliteStateStore.open(agentDbFile(dir))
  try {
    await ScopedState.open(raw, client.binding, { initialize: true })
    const binding = {
      endpoint: client.binding.endpoint_identity,
      vaultId: 'vault',
      mode: 'scoped' as const,
      principalId: 'key',
      principalType: 'key' as const,
      grantId: 'grant',
      generation: 1,
      credentialAssociation: client.binding.credential_fingerprint,
    }
    const external = await ExternalState.open(raw, 'ledger', binding)
    if (withDependency)
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
              representation: 'pending-download',
              preference: 'on-demand',
              pinned: false,
              projectionPath: 'Agents/a.bin.abele-ref',
              projectionSha: 'a'.repeat(64),
              localRevision: 0,
              pendingOperationId: null,
              availability: 'detached',
              blockingReason: 'unavailable',
              lastProvenLocalBase: null,
              retained: [],
            },
          },
        ],
      })
  } finally {
    raw.close()
  }
  return { dir, ctx, fetch }
}
describe('shared scoped/agent lifecycle inventory', () => {
  it('materializes scoped pending bytes and updates existing known state before retiring only that key', async () => {
    const f = await fixture(false),
      cfg = readAgentConfig(f.dir),
      raw = SqliteStateStore.open(agentDbFile(f.dir))
    const bytes = encodeText('scoped attachment'),
      sha = await sha256(bytes)
    const base = {
      fileId: 'file',
      versionId: 'version',
      path: 'Agents/a.bin',
      sha,
      size: bytes.length,
      mtime: 1,
    }
    const scoped = await ScopedState.open(raw, cfg.binding)
    await scoped.putKnown({
      file_id: 'file',
      version_id: 'version',
      path: base.path,
      sha,
      size: bytes.length,
      mtime: 1,
      state: 'known_not_materialized',
      dirty: false,
    })
    const binding = Agent.agentExternalBinding(cfg)
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
            representation: 'pending-download',
            preference: 'on-demand',
            pinned: false,
            projectionPath: null,
            projectionSha: null,
            localRevision: 0,
            pendingOperationId: null,
            availability: 'active',
            blockingReason: null,
            lastProvenLocalBase: base,
            retained: [],
          },
        },
      ],
    })
    raw.close()
    f.fetch.mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname
      expect(path).not.toMatch(/^\/v1\/(vaults|devices)/)
      if (init?.method === 'DELETE') {
        expect(readFileSync(join(f.dir, base.path))).toEqual(Buffer.from(bytes))
        return Response.json({ revoked: true })
      }
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
          path: base.path,
          kind: 'attachment',
          sha,
          size: bytes.length,
          mtime: 1,
        })
      if (path.endsWith('/external/verify'))
        return Response.json({ verified: true, file_id: 'file', ...JSON.parse(String(init?.body)) })
      if (path.endsWith('/versions/version')) return new Response(Buffer.from(bytes))
      throw new Error(`unexpected scoped request ${path}`)
    })
    expect(await runAgentDisconnect({ dir: f.dir, force: true }, f.ctx)).toBe(0)
    expect(existsSync(agentConfigFile(f.dir))).toBe(false)
    const reopened = SqliteStateStore.open(agentDbFile(f.dir)),
      final = await ScopedState.open(reopened, cfg.binding)
    expect((await final.getKnown('file'))?.state).toBe('materialized')
    reopened.close()
  })
  it('BUG: agent activation uses the same durable-instance marker and nested config fence, never a personal descriptor', async () => {
    const f = await fixture(false),
      raw = SqliteStateStore.open(agentDbFile(f.dir))
    const lock = await acquireLock(f.dir)
    try {
      const cfg = readAgentConfig(f.dir)
      const descriptor = await Agent.activateAgentExternalFiles(f.dir, raw, cfg, lock.held)
      expect(descriptor.binding.mode).toBe('scoped')
      expect(descriptor.binding.grantId).toBe('grant')
      expect(descriptor.instanceId).toBe(raw.getExternalInstanceId())
      expect(JSON.parse(readFileSync(agentConfigFile(f.dir), 'utf8')).schema).toBe(2)
      expect(readAgentConfig(f.dir)).toEqual(cfg)
      expect(
        JSON.parse(readFileSync(join(f.dir, '.abele-sync', 'external-activation.json'), 'utf8'))
          .ledgerFile
      ).toBe('agent.sqlite')
    } finally {
      raw.close()
      lock()
    }
  })
  it('refuses a foreign scoped root before materialization or key retirement', async () => {
    const f = await fixture(false),
      raw = SqliteStateStore.open(agentDbFile(f.dir))
    const root = JSON.parse(raw.getMeta('scoped-v4-state')!)
    root.binding.grant_id = 'foreign-grant'
    raw.setMeta('scoped-v4-state', JSON.stringify(root))
    raw.close()
    const before = readFileSync(agentConfigFile(f.dir))
    await expect(runAgentDisconnect({ dir: f.dir, force: true }, f.ctx)).rejects.toThrow()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(readFileSync(agentConfigFile(f.dir))).toEqual(before)
  })
  it('BUG: a live scoped runtime rechecks actual credential bytes, not only a declared fingerprint', async () => {
    const f = await fixture(false),
      vault = await openAgentVault(f.dir, f.ctx)
    try {
      const cfg = JSON.parse(readFileSync(agentConfigFile(f.dir), 'utf8'))
      cfg.token = 'absk_' + 'b'.repeat(43)
      writeFileSync(agentConfigFile(f.dir), JSON.stringify(cfg))
      await expect(vault.client.state()).rejects.toMatchObject({ code: 'lost' })
      expect(f.fetch).not.toHaveBeenCalled()
    } finally {
      vault.close()
    }
  })
  for (const verb of ['run', 'restore', 'disconnect', 'setup'] as const)
    it(`BUG: agent ${verb} refuses pending-download/lost-access dependencies before requests, credential deletion or re-enrollment`, async () => {
      const f = await fixture(),
        config = readFileSync(agentConfigFile(f.dir))
      const work =
        verb === 'run'
          ? runAgentRun({ dir: f.dir, once: true }, f.ctx)
          : verb === 'restore'
            ? runAgentRestore('Agents/a.bin', { dir: f.dir, version: 'version' }, f.ctx)
            : verb === 'disconnect'
              ? runAgentDisconnect({ dir: f.dir, force: true }, f.ctx)
              : runAgentSetup(
                  {
                    dir: f.dir,
                    server: 'https://synthetic.example.test',
                    vault: 'vault',
                    grant: 'grant',
                    principal: 'key',
                  },
                  f.ctx
                )
      await expect(work).rejects.toMatchObject({ reason: 'recovery-required' })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(readFileSync(agentConfigFile(f.dir))).toEqual(config)
      expect(existsSync(agentDbFile(f.dir))).toBe(true)
    })
})
