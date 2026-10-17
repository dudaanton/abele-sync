import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { preparePersonalRetirement, externalLifecycleBinding } from '../externalLifecycle.js'
import { retirePreparedConnection, resumeConnectionRetirement } from '../connectionRetirement.js'
import { assertClaim } from '@abele/sync-node'
import { stateFolder } from '../config.js'
import { EXIT_LOCKED, EXIT_OK, type CommandContext } from '../context.js'
import { lockVault, requireConfig, vaultDir } from '../vault.js'

export interface DisconnectOptions {
  dir: string
}

/** Disconnect is local, not revocation: a pasted token may be shared by other devices. */
export async function runDisconnect(opts: DisconnectOptions, ctx: CommandContext): Promise<number> {
  const dir = vaultDir(opts.dir)
  const lock = await lockVault(dir, ctx, 'stop it before disconnecting')
  if (!lock) return EXIT_LOCKED
  try {
    const claim = () => assertClaim(lock.held)
    if (!(await resumeConnectionRetirement(dir, claim, 'state.db'))) {
      const cfg = requireConfig(dir)
      const inventory = await preparePersonalRetirement(dir, cfg, ctx, claim)
      inventory()
      const external = externalLifecycleBinding(dir, 'state.db')
      if (external) await retirePreparedConnection(dir, 'state.db', external, claim)
      else {
        claim()
        rmSync(join(stateFolder(dir), 'config.json'))
      }
    }
    ctx.io.out('disconnected locally; kept files and ledger; token was not revoked')
    return EXIT_OK
  } finally {
    lock()
  }
}
