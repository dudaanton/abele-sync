import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import { decodeExternalDocument, SyncClient, type ConnectionBinding } from '@abele/sync-core'
import { personalBinding, readConfigDescriptor, stateFolder, type DaemonConfig } from './config.js'
import { assertLocalSafety, guardedFetch } from './externalSafety.js'
import { assertPreparedInventory, materializeForDisconnect } from './externalMaterialization.js'
import type { CommandContext } from './context.js'

/** Read-only detection, never creates an empty ledger to make lifecycle evidence disappear. */
export function externalLifecycleBinding(
  dir: string,
  ledgerFile: 'state.db' | 'agent.sqlite'
): ConnectionBinding | null {
  const file = join(stateFolder(dir), ledgerFile)
  if (!existsSync(file)) return null
  const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('daemon:external-files') as
      { value: string } | undefined
    return row ? decodeExternalDocument(row.value).binding : null
  } finally {
    db.close()
  }
}
export async function preparePersonalRetirement(
  dir: string,
  cfg: DaemonConfig | null,
  ctx: CommandContext,
  claim: () => void
): Promise<() => void> {
  claim()
  const binding = externalLifecycleBinding(dir, 'state.db')
  if (!binding || !cfg) {
    assertLocalSafety(dir, true)
    return () => {
      claim()
      assertLocalSafety(dir, true)
    }
  }
  // Preserve the shared, identity-rich blocker diagnostics before any request.
  const db = new SqliteDatabase(join(stateFolder(dir), 'state.db'), {
    readonly: true,
    fileMustExist: true,
  })
  try {
    const doc = decodeExternalDocument(
      (
        db.prepare('SELECT value FROM meta WHERE key = ?').get('daemon:external-files') as {
          value: string
        }
      ).value
    )
    if (doc.files.some((file) => file.blockingReason)) assertLocalSafety(dir, true)
  } finally {
    db.close()
  }
  const descriptor = readConfigDescriptor(dir)
  const expectedBinding = personalBinding(cfg, descriptor?.binding.generation ?? binding.generation)
  const configFile = join(stateFolder(dir), 'config.json')
  const stamp = createHash('sha256').update(readFileSync(configFile)).digest('hex')
  const check = () => {
    claim()
    if (createHash('sha256').update(readFileSync(configFile)).digest('hex') !== stamp)
      throw new Error('connection changed during retirement preparation')
  }
  const clientFor = (effectGuard: () => void) =>
    new SyncClient({
      baseUrl: cfg.serverUrl,
      token: cfg.deviceToken,
      fetch: guardedFetch(ctx.fetch, () => {
        check()
        effectGuard()
      }),
    }).forVault(cfg.vaultId)
  let scripts: string | undefined
  await materializeForDisconnect(
    dir,
    'state.db',
    expectedBinding,
    {
      scriptsFolder: async (effectGuard) =>
        (scripts ??= (await clientFor(effectGuard).state()).settings.scripts_folder),
      verify: async (base, effectGuard) => {
        const client = clientFor(effectGuard)
        const head = await client.head(base.fileId)
        if (head.kind !== 'attachment')
          throw new Error('approval-required: server head is not an attachment')
        await client.verifyExternalFile(base.fileId, {
          version_id: base.versionId,
          path: base.path,
          sha: base.sha,
          size: base.size,
        })
      },
      download: (base, effectGuard) =>
        clientFor(effectGuard).versionBytes(base.fileId, base.versionId),
    },
    check
  )
  return () => {
    check()
    assertPreparedInventory(dir, 'state.db', [expectedBinding])
  }
}
