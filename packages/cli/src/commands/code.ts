import { EngineError, readStaged, type SyncEngine } from '@abele/sync-core'
import { approveCodeGroup } from '../codeApproval.js'
import { localCodeChanges } from '../codeCheck.js'
import { EXIT_FAILED, EXIT_LOCKED, EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { codeArg, codeFingerprint, codeGroups, codeText, type CodeGroup } from '../pluginCode.js'
import { acquireLock, type Lock } from '../lock.js'
import { openLog } from '../log.js'
import {
  buildEngine,
  DEFAULT_INTERVAL_SECONDS,
  prepareVault,
  requireConfig,
  recoverVault,
  vaultDir,
  type OpenVault,
} from '../vault.js'

export interface CodeOptions {
  dir: string
  approve?: string[]
  reject?: string[]
  expect?: string
}

/** List without a network or lock; decisions use the same exclusive vault lock as the daemon. */
export async function runCode(opts: CodeOptions, ctx: CommandContext): Promise<number> {
  const dir = vaultDir(opts.dir)
  requireConfig(dir)
  if (opts.approve !== undefined && opts.reject !== undefined)
    throw new UsageError('choose --approve or --reject, not both')
  const named = opts.approve ?? opts.reject
  if (named === undefined) {
    if (opts.expect !== undefined) throw new UsageError('--expect needs --approve or --reject')
    const vault = await prepareVault(dir, ctx)
    try {
      const groups = codeGroups(await readStaged(vault.state))
      if (groups.length === 0) ctx.io.out('no plugin code awaiting approval')
      for (const group of groups) await show(group, vault, ctx)
      return EXIT_OK
    } finally {
      vault.close()
    }
  }
  if (opts.expect === undefined)
    throw new UsageError('list code first and pass its --expect fingerprint')
  let release: Lock
  try {
    release = await acquireLock(dir)
  } catch (error) {
    if (!(error instanceof EngineError) || error.code !== 'conflict') throw error
    ctx.io.err('stop the daemon before approving or rejecting code; the vault is locked')
    return EXIT_LOCKED
  }
  let vault: OpenVault | null = null
  let engine: SyncEngine | null = null
  try {
    vault = await prepareVault(dir, ctx, release.held)
    await recoverVault(vault, release.held)
    const ids = [...new Set(named)].sort()
    const groups = codeGroups(await readStaged(vault.state))
    const group = groups.find((one) => JSON.stringify(one.ids) === JSON.stringify(ids))
    if (group === undefined)
      throw new UsageError(
        'the pending code changed, or these are not one listed plugin group; include both ends of a move and list code again'
      )
    if (opts.expect !== codeFingerprint(group))
      throw new UsageError('the pending code changed; list code again before deciding')
    const log = openLog(dir)
    const versions = group.changes.map((change) => change.version_id)
    if (opts.approve !== undefined) {
      const changed = await localCodeChanges(group, vault)
      if (changed.length > 0) {
        for (const path of changed)
          ctx.io.out(`still held ${codeText(path)}: local changes since staging`)
        return EXIT_FAILED
      }
      const result = await approveCodeGroup(vault, group, release.held, (line) => log.line(line))
      for (const path of result.applied) ctx.io.out(`approved ${codeText(path)}`)
      for (const path of result.skipped)
        ctx.io.out(`still held ${codeText(path)}: local changes or unavailable bytes`)
      if (
        result.skipped.length > 0 ||
        (result.unshown ?? []).some((one) => versions.includes(one.version_id))
      )
        return EXIT_FAILED
    } else {
      engine = buildEngine(vault, {
        stillHeld: release.held,
        fallbackMs: DEFAULT_INTERVAL_SECONDS * 1000,
        log: (line) => log.line(line),
      })
      const result = await engine.keepLocal(
        group.changes.flatMap((change) => [
          change.path,
          ...(change.prev_path === null ? [] : [change.prev_path]),
        ]),
        versions
      )
      for (const path of [...result.kept, ...result.left])
        ctx.io.out(`rejected ${codeText(path)}; local code kept`)
    }
    // A blocked keep (for example, another file at the target) remains pending too.
    const remaining = await readStaged(vault.state)
    if (remaining.some((change) => versions.includes(change.version_id))) return EXIT_FAILED
    log.line(
      `code: ${opts.approve === undefined ? 'rejected' : 'approved'} ${codeText(ids.join(', '))} (${opts.expect})`
    )
    return EXIT_OK
  } finally {
    if (engine !== null) await engine.stop()
    vault?.close()
    release()
  }
}

async function show(group: CodeGroup, vault: OpenVault, ctx: CommandContext): Promise<void> {
  const installed = await Promise.all(
    group.ids.map(
      async (id) =>
        (await vault.fs.stat(`.obsidian/plugins/${id}/main.js`)) !== null ||
        (await vault.fs.stat(`.obsidian/plugins/${id}/manifest.json`)) !== null
    )
  )
  ctx.io.out(
    `plugin ${codeText(group.ids.join(','))} (${installed.some(Boolean) ? 'changed' : 'new'}) — ${group.changes.length} files — expect ${codeFingerprint(group)}`
  )
  for (const change of group.changes) {
    ctx.io.out(
      `  ${change.op} ${codeText(change.path)}${change.prev_path === null ? '' : ` from ${codeText(change.prev_path)}`} — version ${codeText(change.version_id)} — sha ${change.sha ?? 'deleted'}`
    )
  }
  ctx.io.out(
    `  approve with --approve ${group.ids.map(codeArg).join(' ')} or reject with --reject; include --expect from this list`
  )
}
