import { rmSync, readFileSync, existsSync, lstatSync } from 'node:fs'
import {
  assertClaim,
  assertLocalSafety,
  guardedFetch,
  inspectProjectionInventory,
} from '../externalSafety.js'
import { SqliteStateStore } from '../sqliteState.js'
import { acquireLock } from '../lock.js'
import { retirePreparedConnection, resumeConnectionRetirement } from '../connectionRetirement.js'
import { externalLifecycleBinding } from '../externalLifecycle.js'
import {
  assertPreparedInventory,
  materializeForDisconnect,
  validateLifecycleLedger,
} from '../externalMaterialization.js'
import { caseKey, normalisePath } from '@abele/sync-protocol'
import { EngineError, pushScoped, sha256, encodeText, type ScopedKnownFile } from '@abele/sync-core'
import {
  openAgentVault,
  openAgentSnapshot,
  agentConfigFile,
  validateAgent,
  type AgentVault,
  agentDirectory,
  agentExternalBinding,
  agentClient,
  readAgentConfig,
  readAgentDescriptor,
  agentDbFile,
} from '../agentVault.js'
import { EXIT_OK, EXIT_FAILED, EXIT_LOCKED, UsageError, type CommandContext } from '../context.js'
export interface AgentMaintenanceOptions {
  dir: string
  version?: string
  cursor?: string
  force?: boolean
  confirm?: boolean
  expect?: string
}
async function locked(
  dir: string,
  ctx: CommandContext,
  run: (vault: AgentVault) => Promise<number>
) {
  let vault: AgentVault
  try {
    vault = await openAgentVault(dir, ctx)
  } catch (error) {
    if (error instanceof EngineError && error.code === 'conflict') {
      ctx.io.err(error.message)
      return EXIT_LOCKED
    }
    throw error
  }
  try {
    return await run(vault)
  } finally {
    vault.close()
  }
}
async function knownFiles(vault: Pick<AgentVault, 'state'>): Promise<ScopedKnownFile[]> {
  const files: ScopedKnownFile[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await vault.state.knownPage(offset)
    files.push(...page)
    if (page.length < 1000) break
  }
  return files
}
async function fileFor(vault: AgentVault, path: string) {
  const wire = normalisePath(path),
    files = await knownFiles(vault),
    matches = files.filter((file) => caseKey(file.path) === caseKey(wire))
  if (matches.length !== 1)
    throw new UsageError('the path has no unambiguous received scoped identity')
  return matches[0]!
}
export async function runAgentStatus(opts: AgentMaintenanceOptions, ctx: CommandContext) {
  const snapshot = await openAgentSnapshot(opts.dir, ctx)
  try {
    const files = await knownFiles(snapshot),
      journal = await snapshot.state.getJournal()
    ctx.io.out(
      JSON.stringify({
        mode: 'agent',
        ...(snapshot.revoked ? { state: 'revoked' } : {}),
        scriptPolicy: 'refuse',
        vault: snapshot.binding.vault_id,
        grant: snapshot.binding.grant_id,
        received: files.length,
        detached: files.filter((f) => f.state === 'detached').length,
        held: files.filter((f) => f.state === 'held' || f.dirty).length,
        pending_request: journal?.request_id ?? null,
      })
    )
    return EXIT_OK
  } finally {
    snapshot.close()
  }
}
export function runAgentHistory(path: string, opts: AgentMaintenanceOptions, ctx: CommandContext) {
  return locked(opts.dir, ctx, async (vault) => {
    await validateAgent(vault.client, false)
    const file = await fileFor(vault, path)
    const page = await vault.client.history(file.file_id, opts.cursor)
    ctx.io.out(JSON.stringify(page))
    return EXIT_OK
  })
}
export function runAgentTrash(opts: AgentMaintenanceOptions, ctx: CommandContext) {
  return locked(opts.dir, ctx, async (vault) => {
    await validateAgent(vault.client, false)
    ctx.io.out(JSON.stringify(await vault.client.trash(opts.cursor)))
    return EXIT_OK
  })
}
export function runAgentRestore(path: string, opts: AgentMaintenanceOptions, ctx: CommandContext) {
  return locked(opts.dir, ctx, async (vault) => {
    await validateAgent(vault.client)
    if (!opts.version)
      throw new UsageError('agent restore requires an exact displayed --version id')
    if (await vault.state.getJournal())
      throw new UsageError('recover the pending scoped request before restoring')
    const file = await fileFor(vault, path)
    if (file.state === 'detached' || file.state === 'known_not_materialized')
      throw new UsageError(
        'detached/unmaterialized data cannot be restored through local identity adoption'
      )
    let cursor: string | undefined,
      found = false
    const seen = new Set<string>()
    for (let pageNo = 0; pageNo < 100; pageNo++) {
      const page = await vault.client.history(file.file_id, cursor)
      if (page.items.some((item) => item.version_id === opts.version && item.sha !== null)) {
        found = true
        break
      }
      if (page.next_cursor === null) break
      if (seen.has(page.next_cursor))
        throw new EngineError('protocol', 'repeated scoped history cursor')
      cursor = page.next_cursor
      seen.add(cursor)
    }
    if (!found)
      throw new UsageError('the selected version is no longer in authorized scoped history')
    const result = await pushScoped({
      client: vault.client,
      state: vault.state,
      fs: vault.disk,
      stillHeld: vault.lock.held,
      ops: [{ op: 'restore', file_id: file.file_id, version_id: opts.version }],
    })
    ctx.io.out(JSON.stringify(result))
    return result.acknowledged ? EXIT_FAILED : EXIT_OK
  })
}
export function runAgentDeletes(opts: AgentMaintenanceOptions, ctx: CommandContext) {
  return locked(opts.dir, ctx, async (vault) => {
    await validateAgent(vault.client)
    if (await vault.state.getJournal())
      throw new UsageError('recover the pending scoped request before deletion decisions')
    const missing = []
    for (const file of await knownFiles(vault)) {
      if (!['materialized', 'held'].includes(file.state)) continue
      const entry = await vault.state.placementStore().byFileId(file.file_id)
      if (entry && (await vault.disk.stat(entry.path)) === null)
        missing.push({
          file_id: entry.fileId,
          base_version_id: entry.versionId,
          path: entry.wirePath,
        })
    }
    missing.sort((a, b) => a.file_id.localeCompare(b.file_id))
    const fingerprint = await sha256(encodeText(JSON.stringify(missing)))
    if (!opts.confirm) {
      ctx.io.out(JSON.stringify({ missing, fingerprint }))
      return EXIT_OK
    }
    if (!opts.expect || opts.expect !== fingerprint)
      throw new UsageError(
        'the missing-file decision changed; display it and confirm the exact --expect fingerprint'
      )
    if (missing.length > 32)
      throw new UsageError('more than 32 delete decisions require a reviewed bounded subset')
    if (!missing.length) {
      ctx.io.out('no scoped delete decisions')
      return EXIT_OK
    }
    const result = await pushScoped({
      client: vault.client,
      state: vault.state,
      fs: vault.disk,
      stillHeld: vault.lock.held,
      ops: missing.map((file) => ({
        op: 'delete',
        file_id: file.file_id,
        base_version_id: file.base_version_id,
      })),
    })
    ctx.io.out(JSON.stringify(result))
    return result.acknowledged ? EXIT_FAILED : EXIT_OK
  })
}
export async function runAgentDisconnect(opts: AgentMaintenanceOptions, ctx: CommandContext) {
  const dir = agentDirectory(opts.dir)
  let lock
  try {
    lock = await acquireLock(dir, ctx.lockTiming)
  } catch (error) {
    if (error instanceof EngineError && error.code === 'conflict') {
      ctx.io.err(error.message)
      return EXIT_LOCKED
    }
    throw error
  }
  let raw: SqliteStateStore | undefined
  try {
    if (await resumeConnectionRetirement(dir, () => assertClaim(lock.held), 'agent.sqlite')) {
      ctx.io.out('completed the recorded scoped disconnect cleanup; kept local data and ledger')
      return EXIT_OK
    }
    const cfg = readAgentConfig(dir),
      stamp = readFileSync(agentConfigFile(dir), 'utf8')
    const ledgerFile = agentDbFile(dir)
    if (
      !existsSync(ledgerFile) ||
      !lstatSync(ledgerFile).isFile() ||
      lstatSync(ledgerFile).isSymbolicLink()
    )
      throw new EngineError('lost', 'agent ledger missing or unsafe')
    let instance: string | null = null
    const check = () => {
      assertClaim(lock.held)
      if (raw && (!raw.isLedgerFile(ledgerFile) || raw.readExternalInstanceId() !== instance))
        throw new EngineError('lost', 'agent physical ledger changed during retirement')
      if (readFileSync(agentConfigFile(dir), 'utf8') !== stamp)
        throw new EngineError('lost', 'agent connection changed during retirement')
    }
    check()
    const binding = agentExternalBinding(cfg, readAgentDescriptor(dir)?.binding.generation)
    const external = externalLifecycleBinding(dir, 'agent.sqlite')
    if (!external) assertLocalSafety(dir, true)
    raw = SqliteStateStore.open(ledgerFile, { effectGuard: check })
    instance = raw.readExternalInstanceId()
    await validateLifecycleLedger(dir, 'agent.sqlite', binding, raw)
    check()
    if (instance === null) instance = raw.getExternalInstanceId()
    if (!external) await inspectProjectionInventory(dir, { guard: check })
    const clientFor = (effectGuard: () => void) =>
      agentClient(cfg, {
        ...ctx,
        fetch: guardedFetch(ctx.fetch, () => {
          check()
          effectGuard()
        }),
      })
    const client = await clientFor(check)
    if (external)
      await materializeForDisconnect(
        dir,
        'agent.sqlite',
        binding,
        {
          scriptsFolder: 'Scripts',
          verify: async (base, effectGuard) => {
            const client = await clientFor(effectGuard)
            const head = await client.head(base.fileId)
            if (head.kind !== 'attachment')
              throw new UsageError('approval-required: not a scoped attachment')
            await client.verifyExternalFile(base.fileId, {
              version_id: base.versionId,
              path: base.path,
              sha: base.sha,
              size: base.size,
            })
          },
          download: async (base, effectGuard) =>
            (await clientFor(effectGuard)).version(base.fileId, base.versionId),
        },
        check
      )
    const prepared = () => {
      check()
      if (external) assertPreparedInventory(dir, 'agent.sqlite', [binding])
      else assertLocalSafety(dir, true)
    }
    prepared()
    let retired = false
    try {
      await client.revokeSelf()
      retired = true
    } catch (error) {
      if (!opts.force) throw error
    }
    prepared()
    if (external)
      await retirePreparedConnection(dir, 'agent.sqlite', binding, () => assertClaim(lock.held))
    else rmSync(agentConfigFile(dir))
    ctx.io.out(
      retired
        ? 'retired only this scoped credential; kept local data and ledger'
        : 'forgot the credential locally; revoke its key from owner settings; local data and ledger retained'
    )
    return EXIT_OK
  } finally {
    raw?.close()
    lock()
  }
}
