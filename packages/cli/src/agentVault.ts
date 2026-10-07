import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  readdirSync,
  mkdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  EngineError,
  ScopedConnectionSchema,
  ScopedState,
  createScopedClient,
  pullScoped,
  pushScoped,
  scanScopedChanges,
  type ScopedClient,
  type ScopedConnection,
} from '@abele/sync-core'
import { stateFolder, ensureStateFolder } from './config.js'
import { NodeFileSystem } from './nodeFs.js'
import { SqliteStateStore } from './sqliteState.js'
import { acquireLock, type Lock } from './lock.js'
import { UsageError, type CommandContext } from './context.js'
import { wasRevoked } from './revoked.js'
const ConfigSchema = z
  .object({
    mode: z.literal('agent'),
    scriptPolicy: z.literal('refuse'),
    binding: ScopedConnectionSchema,
    token: z.string().regex(/^absk_[A-Za-z0-9_-]{43}$/),
  })
  .strict()
export type AgentConfig = z.infer<typeof ConfigSchema>
export const agentConfigFile = (dir: string) => join(stateFolder(dir), 'agent.json')
export const agentDbFile = (dir: string) => join(stateFolder(dir), 'agent.sqlite')
export function agentDirectory(dir: string): string {
  const root = resolve(dir)
  if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new UsageError('agent --dir must be a real dedicated vault root')
  const own = stateFolder(root)
  if (existsSync(own) && (!lstatSync(own).isDirectory() || lstatSync(own).isSymbolicLink()))
    throw new UsageError('agent state folder must not be a symlink')
  if (existsSync(join(own, 'config.json')))
    throw new UsageError('personal and agent connections cannot share a vault root')
  return root
}
export function readAgentConfig(dir: string): AgentConfig {
  const file = agentConfigFile(dir)
  if (!existsSync(file) || lstatSync(file).isSymbolicLink())
    throw new UsageError('agent is not set up, or its config is unsafe')
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    throw new EngineError('lost', 'agent config requires reviewed recovery')
  }
}
export function writeAgentConfig(dir: string, cfg: AgentConfig): void {
  const folder = ensureStateFolder(dir),
    temporary = join(folder, `agent.${crypto.randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(ConfigSchema.parse(cfg)), { mode: 0o600, flag: 'wx' })
    chmodSync(temporary, 0o600)
    renameSync(temporary, agentConfigFile(dir))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
export async function agentClient(cfg: AgentConfig, ctx: CommandContext): Promise<ScopedClient> {
  const client = await createScopedClient({
    baseUrl: cfg.binding.endpoint_identity,
    vaultId: cfg.binding.vault_id,
    grantId: cfg.binding.grant_id,
    principalId: cfg.binding.principal_id,
    principalKind: 'key',
    token: cfg.token,
    fetch: ctx.fetch,
  })
  if (JSON.stringify(client.binding) !== JSON.stringify(cfg.binding))
    throw new EngineError('lost', 'agent credential binding changed')
  return client
}
export async function validateAgent(client: ScopedClient, requireEditor = true) {
  const negotiated = await client.negotiate()
  if (negotiated.state.selector.kind !== 'folder' || negotiated.state.selector.prefix !== 'Agents/')
    throw new UsageError(
      'agent mode requires the Agents/ folder grant and the vault root, never prefix stripping'
    )
  if (requireEditor && negotiated.state.role !== 'editor')
    throw new UsageError('agent mode requires editor authority')
  return negotiated
}
export interface AgentVault {
  dir: string
  client: ScopedClient
  state: ScopedState
  disk: NodeFileSystem
  raw: SqliteStateStore
  lock: Lock
  close(): void
}
function checkedAgentLedger(dir: string): string {
  const file = agentDbFile(dir)
  if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
    throw new EngineError('lost', 'agent ledger missing or unsafe; explicit recovery is required')
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(file + suffix) && lstatSync(file + suffix).isSymbolicLink())
      throw new EngineError('lost', 'unsafe agent ledger sidecar')
  }
  return file
}
/** Local status only. No vault claim, initialization, reconciliation or HTTP;
 * configuration/credential binding and ledger validation remain fail-closed.
 */
export async function openAgentSnapshot(dir: string, ctx: CommandContext) {
  const root = agentDirectory(dir),
    cfg = readAgentConfig(root)
  const client = await agentClient(cfg, ctx)
  const raw = SqliteStateStore.openReadOnlySnapshot(checkedAgentLedger(root))
  try {
    const state = await ScopedState.open(raw, cfg.binding)
    return {
      binding: client.binding,
      state,
      revoked: wasRevoked(raw, JSON.stringify(client.binding)),
      close: () => raw.close(),
    }
  } catch (error) {
    raw.close()
    throw error
  }
}
export async function openAgentVault(dir: string, ctx: CommandContext): Promise<AgentVault> {
  const root = agentDirectory(dir),
    lock = await acquireLock(root, { ...ctx.lockTiming, daemon: false })
  let raw: SqliteStateStore | undefined
  try {
    const cfg = readAgentConfig(root)
    const file = checkedAgentLedger(root)
    const client = await agentClient(cfg, ctx)
    raw = SqliteStateStore.open(file)
    const state = await ScopedState.open(raw, cfg.binding),
      disk = new NodeFileSystem(root, { skipHidden: true })
    return {
      dir: root,
      client,
      state,
      disk,
      raw,
      lock,
      close: () => {
        raw?.close()
        lock()
      },
    }
  } catch (error) {
    raw?.close()
    lock()
    throw error
  }
}
export async function agentCycle(vault: AgentVault) {
  const { client, state, disk, lock } = vault
  await validateAgent(client)
  if (await state.getJournal()) {
    const recovered = await pushScoped({ client, state, fs: disk, stillHeld: lock.held })
    if (recovered.acknowledged) return { pull: null, push: recovered }
  }
  const pull = await pullScoped({ client, state, fs: disk, stillHeld: lock.held })
  const ops = await scanScopedChanges(disk, state, 'Agents/')
  const push = await pushScoped({ client, state, fs: disk, ops, stillHeld: lock.held })
  return { pull, push }
}
export function freshAgentRoot(dir: string) {
  if (existsSync(agentConfigFile(dir)) || existsSync(agentDbFile(dir)))
    throw new UsageError('agent is already set up or an interrupted setup needs recovery')
  if (readdirSync(dir).some((name) => name !== '.abele-sync'))
    throw new UsageError(
      'agent setup needs a fresh dedicated vault root; do not pass Agents itself'
    )
}
export function createAgentsFolder(dir: string) {
  mkdirSync(join(dir, 'Agents'), { recursive: true })
}
