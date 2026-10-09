import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScopedClient, ExternalState, ScopedState } from '@abele/sync-core'
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
    fetch = vi.fn(async () => {
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
