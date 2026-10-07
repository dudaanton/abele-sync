import type { VersionInfo } from '@abele/sync-protocol'
import type { VaultClient } from '@abele/sync-core'
import { EXIT_OK, UsageError, type CommandContext } from '../context.js'
import { unifiedDiff } from '../diff.js'
import { fileIdFor, humanBytes, openVault, vaultDir, wirePath } from '../vault.js'

/**
 * What has happened to one file, and what changed between two of its versions.
 *
 * The versions come newest first, as the server keeps them. `--diff` fetches the bytes of
 * two of them and prints a unified diff — of the text, because that is what a diff is: two
 * versions of a picture are reported as differing and left at that, rather than filled down
 * the terminal with bytes nobody can read.
 */

export interface HistoryOptions {
  dir: string
  /** Two versions, each a version id or a version number. */
  diff?: string[]
}

/** How many versions one page of history shows, and how far back `--diff` can name one. */
const PAGE = 50

export async function runHistory(
  path: string,
  opts: HistoryOptions,
  ctx: CommandContext
): Promise<number> {
  // Checked before anything is opened or asked for: a mistyped `--diff` should cost a line, not
  // a walk of the manifest.
  if (opts.diff !== undefined && opts.diff.length !== 2) {
    throw new UsageError('--diff takes two versions: --diff <a> <b>')
  }
  const vault = openVault(vaultDir(opts.dir), ctx)
  try {
    const wire = wirePath(path)
    const fileId = await fileIdFor(vault.client, vault.state, wire)
    const versions = await vault.client.versions(fileId, { limit: PAGE })
    if (opts.diff === undefined) {
      list(versions, ctx)
      return EXIT_OK
    }
    const from = pick(versions, opts.diff[0]!, wire)
    const to = pick(versions, opts.diff[1]!, wire)
    await diff(vault.client, fileId, wire, from, to, ctx)
    return EXIT_OK
  } finally {
    vault.close()
  }
}

/** One line per version: what it is, what it did, how big it left the file, and who. */
function list(versions: VersionInfo[], ctx: CommandContext): void {
  if (versions.length === 0) {
    ctx.io.out('no versions')
    return
  }
  for (const version of versions) {
    ctx.io.out(
      [
        version.version_id,
        `#${version.no}`,
        version.op.padEnd(8),
        humanBytes(version.size).padStart(8),
        version.actor.name,
        version.at,
      ].join('  ')
    )
  }
}

/** The unified diff of two versions' texts, or what can be said about two that are not text. */
async function diff(
  client: VaultClient,
  fileId: string,
  path: string,
  from: VersionInfo,
  to: VersionInfo,
  ctx: CommandContext
): Promise<void> {
  const [before, after] = await Promise.all([
    client.versionBytes(fileId, from.version_id),
    client.versionBytes(fileId, to.version_id),
  ])
  const beforeText = asText(before)
  const afterText = asText(after)
  if (beforeText === null || afterText === null) {
    if (from.sha === to.sha) {
      ctx.io.out(`#${from.no} and #${to.no} of ${path} are the same bytes`)
      return
    }
    ctx.io.out(
      `binary versions differ: #${from.no} is ${humanBytes(from.size)}, ` +
        `#${to.no} is ${humanBytes(to.size)}`
    )
    return
  }
  const lines = unifiedDiff(beforeText, afterText, {
    from: `${path} #${from.no} ${from.at}`,
    to: `${path} #${to.no} ${to.at}`,
  })
  if (lines.length === 0) {
    ctx.io.out(`#${from.no} and #${to.no} of ${path} are the same text`)
    return
  }
  for (const line of lines) ctx.io.out(line)
}

/** Which version a `--diff` argument names: a version id, or `#3` or `3` for its number. */
function pick(versions: VersionInfo[], key: string, path: string): VersionInfo {
  const byId = versions.find((version) => version.version_id === key)
  if (byId) return byId
  const no = Number(key.replace(/^#/, ''))
  const byNo = Number.isInteger(no) ? versions.find((version) => version.no === no) : undefined
  if (byNo) return byNo
  throw new UsageError(`${path} has no version ${key} among its last ${PAGE}`)
}

/** The bytes as text, or null when they are not text at all. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
