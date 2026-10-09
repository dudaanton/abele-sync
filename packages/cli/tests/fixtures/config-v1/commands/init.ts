import { existsSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { selectiveDefaults, SyncClient } from '@abele/sync-core'
import { serverUrlProblem, type JoinPrefer, type VaultInfo } from '@abele/sync-protocol'
import {
  readConfig,
  stateFolder,
  writeConfig,
  assertNoAgentConnection,
  type DaemonConfig,
} from '../config.js'
import { EXIT_LOCKED, EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { joinPrefer, parsePrefer } from '../join.js'
import { promptPassword } from '../password.js'
import { SqliteStateStore } from '../sqliteState.js'
import {
  leavingClient,
  lockVault,
  requireServerUrl,
  stateDbFile,
  statedVault,
  vaultDir,
} from '../vault.js'

/**
 * Set a vault up: log in, find or make the vault, enrol this machine as a device, and write
 * the config the daemon runs on.
 *
 * The password is read once — from the flag, from the environment, or from a person at the
 * terminal with nothing echoed — and passed straight to `login`; it is never printed, never
 * logged and never written anywhere. Neither is the device token that comes back — it goes
 * into the config, which `writeConfig` puts at 0600 inside a 0700 folder, and what this
 * prints is where the file is, not what is in it.
 *
 * A vault that is already set up is not set up again. Enrolling twice would leave a second
 * device on the server and a second token here, and the state database beside the config
 * describes a device that no longer signs its commits; so the second `init` says so and
 * stops. `--force` is for when that is the point — a token the server has revoked — and
 * keeps the state database only when the vault it describes is the one enrolled into again.
 * The device it replaces is revoked once the new one is written, so no token is left live on
 * the server with nothing using it.
 *
 * The server address must be https, or plain http to this machine (`serverUrlProblem`), and
 * the config holds it in its one spelling (`normalizeServerUrl`), not as it was typed.
 *
 * The vault's lock is held throughout: `--force` writes a new config and revokes the old token,
 * which would leave a running daemon syncing on a token that no longer works.
 *
 * A folder that holds files joining a vault that holds files is asked which side wins where
 * both have one (`join.ts`), before anything is enrolled: at a terminal, or by `--prefer`, and
 * otherwise not at all — a script is refused with exit 2. The answer goes into the config as
 * `joinPrefer` and leaves it once the first sync has finished the join (`run`).
 *
 * The state database beside the config is kept only when it describes the vault enrolled into,
 * with or without `--force`: a folder disconnected from one vault and set up on another would
 * otherwise push edits against file ids the new vault has never heard of.
 */

export interface InitOptions {
  server: string
  dir: string
  email: string
  password?: string
  vault?: string
  deviceName?: string
  force?: boolean
  /** `merge`, `local` or `server`: which side wins where the folder and the vault both hold a file. */
  prefer?: string
}

export async function runInit(opts: InitOptions, ctx: CommandContext): Promise<number> {
  // Before anything is asked or sent: the password would cross the wire next.
  const server = requireServerUrl(opts.server)
  const given = opts.prefer === undefined ? undefined : parsePrefer(opts.prefer)
  const dir = vaultDir(opts.dir)
  assertNoAgentConnection(dir)
  const configFile = join(stateFolder(dir), 'config.json')
  if (opts.force !== true && readConfig(dir) !== null) {
    throw new UsageError(`${dir} is already set up: its config is at ${configFile}`)
  }
  const release = await lockVault(dir, ctx, 'stop it before setting up again')
  if (release === null) return EXIT_LOCKED
  try {
    // Recheck under the shared physical-vault lock before credentials/login or
    // any force-mode helper can catch a config-read refusal and treat it as empty.
    assertNoAgentConnection(dir)
    return await setUp({ ...opts, server }, given, dir, configFile, ctx)
  } finally {
    release()
  }
}

async function setUp(
  opts: InitOptions,
  given: JoinPrefer | null | undefined,
  dir: string,
  configFile: string,
  ctx: CommandContext
): Promise<number> {
  const previous = previousVault(dir)
  const replaced = opts.force === true ? previousConfig(dir) : null
  const password = await passwordFor(opts, ctx)

  const { account_token } = await SyncClient.login(opts.server, ctx.fetch, opts.email, password)
  const client = new SyncClient({
    baseUrl: opts.server,
    fetch: ctx.fetch,
    token: account_token,
    userAgent: 'abele-sync-daemon',
  })
  const vault = await chooseVault(client, opts.vault, dir)
  const selective = selectiveDefaults()
  const joined = previous === vault.id && (await walkedVault(dir))
  const unfinished = previous === vault.id && !joined ? replaced?.joinPrefer : undefined
  const prefer = await joinPrefer(
    {
      dir,
      vault: vault.info,
      vaultName: vault.name,
      keptLedger: joined,
      selective,
      given,
      ...(unfinished === undefined ? {} : { unfinished }),
    },
    ctx
  )
  const deviceName = opts.deviceName ?? hostname()
  const device = await client.enrolDevice(vault.id, deviceName, 'daemon')

  // Removing foreign state first is crash-safe: the old config can rebuild a
  // fresh ledger, but the new config must never see another vault's cursor.
  settleState(dir, previous, vault.id, ctx)
  writeConfig(dir, {
    serverUrl: opts.server,
    vaultId: vault.id,
    deviceId: device.device_id,
    deviceToken: device.device_token,
    deviceName,
    selective,
    ...(prefer === null ? {} : { joinPrefer: prefer }),
  })

  ctx.io.out(`vault ${vault.name} (${vault.id})`)
  ctx.io.out(`device ${deviceName} (${device.device_id})`)
  ctx.io.out(`wrote ${configFile}`)
  if (prefer !== null) {
    const side = prefer === 'mine' ? "this folder's" : "the server's"
    ctx.io.out(
      `joining: where both hold a file, ${side} is kept and the other goes to version history`
    )
  }
  if (replaced !== null) await revokeReplaced(replaced, ctx)
  return EXIT_OK
}

/**
 * Whether the state database beside the config has walked its vault: it is there and its feed
 * position is above 0. One that never got that far is a join that has not finished.
 */
async function walkedVault(dir: string): Promise<boolean> {
  const file = stateDbFile(dir)
  if (!existsSync(file)) return false
  try {
    const state = SqliteStateStore.open(file)
    try {
      return (await state.getCursor()) > 0
    } finally {
      state.close()
    }
  } catch {
    return false
  }
}

/** The config `--force` is about to write over, if it can be read: the device it replaces. */
function previousConfig(dir: string): DaemonConfig | null {
  try {
    return readConfig(dir)
  } catch {
    return null
  }
}

/**
 * Tell the server the device `--force` replaced is gone, so its token stops working rather than
 * lingering on the server with nothing left to use it. Best effort, and only once the new device
 * is written: a failure here costs a line of advice, never the setup that just succeeded.
 */
async function revokeReplaced(old: DaemonConfig, ctx: CommandContext): Promise<void> {
  const leftover = `the old device ${old.deviceName} (${old.deviceId}) is still enrolled on ${old.serverUrl}; revoke it from the account`
  if (serverUrlProblem(old.serverUrl) !== null) {
    // Its token is not sent over plain http to another machine, not even to revoke it.
    ctx.io.out(leftover)
    return
  }
  try {
    const outcome = await leavingClient(old, ctx).revokeSelf()
    ctx.io.out(
      outcome === 'revoked'
        ? `revoked the old device (${old.deviceId})`
        : `the old device (${old.deviceId}) was already revoked`
    )
  } catch {
    ctx.io.out(leftover)
  }
}

/**
 * The password, from wherever it was given: the flag, the environment, or — with a person at
 * the terminal and neither of those — a prompt that echoes nothing. A script with no terminal
 * is told what to set rather than left waiting on a prompt it cannot answer.
 */
async function passwordFor(opts: InitOptions, ctx: CommandContext): Promise<string> {
  const given = opts.password ?? ctx.env.ABELE_PASSWORD ?? ''
  if (given !== '') return given
  const { stdin, stderr } = ctx.io
  if (stdin?.isTTY === true && stderr !== undefined) {
    const typed = await promptPassword(stdin, stderr)
    if (typed !== '') return typed
  }
  throw new UsageError('no password: pass --password or set ABELE_PASSWORD')
}

/**
 * Which vault the state database beside the config describes, for `init` to compare with
 * the vault enrolled into: the config's word if it is readable, else what the daemon filed in
 * the state itself, else nothing — and nothing means the state cannot be trusted to match.
 */
function previousVault(dir: string): string | null {
  const file = stateDbFile(dir)
  if (existsSync(file)) {
    try {
      const state = SqliteStateStore.open(file)
      try {
        const owner = statedVault(state)
        if (owner !== null) return owner
      } finally {
        state.close()
      }
    } catch {
      return null
    }
  }
  try {
    return readConfig(dir)?.vaultId ?? null
  } catch {
    return null
  }
}

/**
 * The state database, kept when it describes the very vault just enrolled into — the usual
 * case, a device re-enrolled after its token was revoked, which then has nothing to re-download —
 * and removed otherwise, since entries that name another vault's files would have the first sync
 * push edits against ids the server has never heard of.
 */
function settleState(
  dir: string,
  previous: string | null,
  vaultId: string,
  ctx: CommandContext
): void {
  const file = stateDbFile(dir)
  if (!existsSync(file)) return
  if (previous === vaultId) {
    ctx.io.out('kept state.db: the same vault')
    return
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true })
  ctx.io.out(
    previous === null
      ? 'removed state.db: it did not say which vault it described'
      : 'removed state.db: it described another vault'
  )
}

/** A vault `init` settled on, and what the server said about it; null info for one just made. */
interface Chosen {
  id: string
  name: string
  info: VaultInfo | null
}

/** The vault this directory is to sync with: the one named, the only one, or a new one. */
async function chooseVault(
  client: SyncClient,
  named: string | undefined,
  dir: string
): Promise<Chosen> {
  const vaults = await client.listVaults()
  if (named !== undefined) {
    const found = vaults.find((vault) => vault.name === named)
    if (found) return { id: found.id, name: found.name, info: found }
    return create(client, named)
  }
  const only = onlyOne(vaults)
  if (only) return { id: only.id, name: only.name, info: only }
  if (vaults.length === 0) return create(client, basename(dir))
  const names = vaults.map((vault) => vault.name).join(', ')
  throw new UsageError(`this account has several vaults; name one with --vault: ${names}`)
}

const onlyOne = (vaults: VaultInfo[]): VaultInfo | undefined =>
  vaults.length === 1 ? vaults[0] : undefined

async function create(client: SyncClient, name: string): Promise<Chosen> {
  const { id } = await client.createVault(name)
  return { id, name, info: null }
}
