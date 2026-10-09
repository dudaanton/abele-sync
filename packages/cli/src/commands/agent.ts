import { EngineError, ScopedState, createScopedClient } from '@abele/sync-core'
import { acquireLock } from '../lock.js'
import {
  assertClaim,
  assertLocalSafety,
  inspectProjectionInventory,
  guardedFetch,
} from '../externalSafety.js'
import { SqliteStateStore } from '../sqliteState.js'
import {
  agentDirectory,
  agentDbFile,
  writeAgentConfig,
  freshAgentRoot,
  createAgentsFolder,
  validateAgent,
  openAgentVault,
  agentCycle,
} from '../agentVault.js'
import { EXIT_OK, EXIT_LOCKED, EXIT_REVOKED, UsageError, type CommandContext } from '../context.js'
import { isUnauthorized } from '../vault.js'
import { recordRevoked, wasRevoked } from '../revoked.js'
import { openLog } from '../log.js'
export interface AgentSetupOptions {
  dir: string
  server: string
  vault: string
  grant: string
  principal: string
}
export interface AgentRunOptions {
  dir: string
  once?: boolean
  interval?: string
}
export async function runAgentSetup(opts: AgentSetupOptions, ctx: CommandContext) {
  const dir = agentDirectory(opts.dir),
    token = ctx.env.ABELE_AGENT_TOKEN
  if (!token)
    throw new UsageError(
      'set ABELE_AGENT_TOKEN to the scoped machine key; no owner password is used'
    )
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
    const check = () => {
      assertClaim(lock.held)
      assertLocalSafety(dir, true)
    }
    check()
    freshAgentRoot(dir)
    await inspectProjectionInventory(dir, { guard: check })
    const client = await createScopedClient({
      baseUrl: opts.server,
      token,
      fetch: guardedFetch(ctx.fetch, check),
      vaultId: opts.vault,
      grantId: opts.grant,
      principalId: opts.principal,
      principalKind: 'key',
    })
    await validateAgent(client)
    check()
    raw = SqliteStateStore.open(agentDbFile(dir), { effectGuard: () => assertClaim(lock.held) })
    await ScopedState.open(raw, client.binding, { initialize: true })
    if (!lock.held()) throw new EngineError('lost', 'agent setup claim lost')
    createAgentsFolder(dir, () => assertClaim(lock.held))
    writeAgentConfig(
      dir,
      { mode: 'agent', scriptPolicy: 'refuse', binding: client.binding, token },
      () => assertClaim(lock.held)
    )
    ctx.io.out('agent folder connection set up; exact paths, script policy refuse')
    return EXIT_OK
  } finally {
    raw?.close()
    lock()
  }
}
export async function runAgentRun(opts: AgentRunOptions, ctx: CommandContext) {
  const seconds = opts.interval === undefined ? 30 : Number(opts.interval)
  if (!Number.isFinite(seconds) || seconds < 5)
    throw new UsageError('agent polling interval is at least 5 seconds')
  let vault
  try {
    vault = await openAgentVault(opts.dir, ctx)
  } catch (error) {
    if (error instanceof EngineError && error.code === 'conflict') {
      ctx.io.err(error.message)
      return EXIT_LOCKED
    }
    throw error
  }
  let stopped = false,
    wake: (() => void) | undefined
  const stop = () => {
    stopped = true
    wake?.()
  }
  if (!opts.once) {
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  }
  const binding = JSON.stringify(vault.client.binding)
  const revoked = () => {
    const line =
      'agent: stopping: machine key was revoked or is no longer authorized; issue a new key and set up a fresh agent root'
    openLog(vault.dir).line(line)
    ctx.io.err(line)
    if (!recordRevoked(vault.raw, binding))
      ctx.io.err('revoked status could not be saved; recover the local ledger before restarting')
    return EXIT_REVOKED
  }
  try {
    if (wasRevoked(vault.raw, binding)) return revoked()
    do {
      if (!vault.lock.held()) throw new EngineError('lost', 'agent writer claim lost')
      const report = await agentCycle(vault)
      ctx.io.out(
        `agent: applied ${report.pull?.applied ?? 0}, held ${report.pull?.held.length ?? 0}, committed ${report.push.committed}, acknowledgement hold ${report.push.acknowledged}`
      )
      if (opts.once || stopped) break
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined
          resolve()
        }, seconds * 1000)
        wake = () => {
          clearTimeout(timer)
          wake = undefined
          resolve()
        }
      })
    } while (!stopped)
    return EXIT_OK
  } catch (error) {
    if (isUnauthorized(error)) return revoked()
    throw error
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    vault.close()
  }
}
