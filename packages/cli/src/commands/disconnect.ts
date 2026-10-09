import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { EngineError } from '@abele/sync-core'
import { preparePersonalRetirement, externalLifecycleBinding } from '../externalLifecycle.js'
import { retirePreparedConnection, resumeConnectionRetirement } from '../connectionRetirement.js'
import {
  assertClaim,
  assertLocalSafety,
  inspectProjectionInventory,
  guardedFetch,
} from '../externalSafety.js'
import { join } from 'node:path'
import { serverUrlProblem } from '@abele/sync-protocol'
import { stateFolder, type DaemonConfig } from '../config.js'
import { EXIT_FAILED, EXIT_LOCKED, EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { leavingClient, lockVault, requireConfig, vaultDir } from '../vault.js'

/**
 * Take this folder off its vault: tell the server the device is leaving, so its token stops
 * working there, then remove the config that held the token.
 *
 * The state database stays. Setting the folder up again on the same vault (`init`) finds the
 * files already filed and has nothing to download twice; on another vault `init --force`
 * clears it as it always has.
 *
 * A device the server could not be told about is not forgotten quietly: its token would stay
 * live on the server with nobody holding it. Without `--force` the command refuses and changes
 * nothing; with it the config goes anyway, and the device id is printed so the account can
 * revoke it by hand. A server that already refuses the token has let the device go already,
 * which is as good as revoking it now.
 *
 * The vault's lock is taken first: removing the config under a running daemon would leave it
 * syncing on a token that no longer works.
 */

export interface DisconnectOptions {
  dir: string
  force?: boolean
}

export async function runDisconnect(opts: DisconnectOptions, ctx: CommandContext): Promise<number> {
  const dir = vaultDir(opts.dir)
  const release = await lockVault(dir, ctx, 'stop it before disconnecting')
  if (release === null) return EXIT_LOCKED

  try {
    if (await resumeConnectionRetirement(dir, () => assertClaim(release.held), 'state.db')) {
      ctx.io.out('completed the recorded disconnect cleanup; kept local data and ledger')
      return EXIT_OK
    }
    const cfg = requireConfig(dir)
    const inventory = await preparePersonalRetirement(dir, cfg, ctx, () =>
      assertClaim(release.held)
    )
    // A legacy unsafe URL can still be forgotten locally when the inventory is
    // clear; its token must never be sent merely to compute/validate a binding.
    const configStamp = () =>
      createHash('sha256')
        .update(readFileSync(join(stateFolder(dir), 'config.json')))
        .digest('hex')
    const stamp = configStamp()
    const check = () => {
      assertClaim(release.held)
      inventory()
      if (configStamp() !== stamp)
        throw new EngineError('lost', 'connection changed during disconnect')
    }
    await inspectProjectionInventory(dir, { guard: check, selective: cfg.selective })
    const told = await tellServer(cfg, { ...ctx, fetch: guardedFetch(ctx.fetch, check) })
    if (told !== null) {
      ctx.io.out(told)
    } else if (opts.force === true) {
      ctx.io.out(
        `the server was not told: device ${cfg.deviceName} (${cfg.deviceId}) is still enrolled ` +
          `on ${cfg.serverUrl}; revoke it from the account`
      )
    } else {
      ctx.io.err(
        `could not tell ${cfg.serverUrl} that this device is leaving; nothing was changed. ` +
          'Try again when it can be reached, or pass --force to forget the device here anyway'
      )
      return EXIT_FAILED
    }
    check()
    const external = externalLifecycleBinding(dir, 'state.db')
    if (external)
      await retirePreparedConnection(dir, 'state.db', external, () => assertClaim(release.held))
    else forgetConfig(dir)
    ctx.io.out(`removed ${join(stateFolder(dir), 'config.json')}; kept state.db`)
    return EXIT_OK
  } finally {
    release()
  }
}

/**
 * What the server said to the device leaving, as the line to print, or null when it could not
 * be told: unreachable, a fault, or an address the token is not sent to in the clear.
 */
async function tellServer(cfg: DaemonConfig, ctx: CommandContext): Promise<string | null> {
  const problem = serverUrlProblem(cfg.serverUrl)
  if (problem !== null) {
    ctx.io.err(`${cfg.serverUrl}: ${problem}`)
    return null
  }
  try {
    const outcome = await leavingClient(cfg, ctx).revokeSelf()
    return outcome === 'revoked'
      ? `revoked device ${cfg.deviceName} (${cfg.deviceId}) on ${cfg.serverUrl}`
      : `device ${cfg.deviceName} (${cfg.deviceId}) was already revoked on ${cfg.serverUrl}`
  } catch (error) {
    if (error instanceof UsageError) throw error
    ctx.io.err(error instanceof Error ? error.message : String(error))
    return null
  }
}

function forgetConfig(dir: string): void {
  rmSync(join(stateFolder(dir), 'config.json'), { force: true })
}
