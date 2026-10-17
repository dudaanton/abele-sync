import { AccessClient, selectiveDefaults } from '@abele/sync-core'
import { decodeAccessToken } from '@abele/sync-protocol'
import { mkdirSync, existsSync } from 'node:fs'
import { readConfig, writeConfig } from '../config.js'
import { EXIT_LOCKED, EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { assertLocalSafety } from '@abele/sync-node'
import { lockVault, vaultDir, stateDbFile } from '../vault.js'
import { SqliteStateStore } from '@abele/sync-node'
import { createHash } from 'node:crypto'

export interface ConnectOptions {
  dir: string
  token?: string
}

/** Validate before persistence. No enrolment, no fallback, no replacement of a live ledger. */
export async function runConnect(opts: ConnectOptions, ctx: CommandContext): Promise<number> {
  const encoded = opts.token ?? ctx.env.ABELE_TOKEN
  if (!encoded) throw new UsageError('connect requires --token or ABELE_TOKEN')
  const decoded = decodeAccessToken(encoded)
  const access = AccessClient.fromToken(encoded, { fetch: ctx.fetch })
  const dir = vaultDir(opts.dir)
  mkdirSync(dir, { recursive: true })
  const lock = await lockVault(dir, ctx, 'stop it before connecting')
  if (!lock) return EXIT_LOCKED
  try {
    assertLocalSafety(dir)
    if (readConfig(dir)) throw new UsageError('already connected; disconnect first')
    const info = await access.connection()
    if (info.status !== 'active') throw new UsageError(`connection ${info.status}`)
    if (!lock.held()) throw new UsageError('connection lock was lost')
    assertLocalSafety(dir)
    if (existsSync(stateDbFile(dir))) {
      const state = SqliteStateStore.openReadOnlySnapshot(stateDbFile(dir))
      try {
        if (
          state.getMeta('token-connection') !== createHash('sha256').update(encoded).digest('hex')
        )
          throw new UsageError(
            'this directory retains another connection ledger; use a fresh directory'
          )
      } finally {
        state.close()
      }
    }
    writeConfig(dir, {
      deviceToken: encoded,
      serverUrl: decoded.address,
      vaultId: info.space_id,
      deviceId: info.token_id,
      deviceName: 'token connection',
      selective: selectiveDefaults(),
    })
    ctx.io.out(`connected ${info.scope.kind} ${info.scope.path} at ${decoded.address}`)
    return EXIT_OK
  } finally {
    lock()
  }
}
