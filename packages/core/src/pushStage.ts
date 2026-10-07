import type { ChangeItem, CommitOpResult, VersionInfo } from '@abele/sync-protocol'
import type { VaultClient } from './client.js'
import type { Staged } from './defer.js'

/**
 * A push answered with the server's bytes for a path the host stages. The pusher does not write them: Obsidian holds its
 * settings in memory and would write the old ones back. It records the file against the version
 * that holds what this device sent — the server keeps the loser as a version of its own — and
 * hands the head over as a staged change against that version, as if a pull had brought it. So
 * "Reload" writes the head, and "Keep this device's" sends this disk over the head again.
 */

/** How many versions one history request asks for while looking for the bytes sent. */
const VERSION_PAGE = 100

/**
 * The head a verdict answered with, as a change staged against the version holding `sentSha`;
 * if history no longer has those bytes, retain the previous base instead. Missing history is
 * never permission to write bytes the host has not approved.
 */
export async function stagedHead(
  client: VaultClient,
  result: Exclude<CommitOpResult, { status: 'rejected' }>,
  sentSha: string | null,
  fallbackBase: string | null,
  source: string
): Promise<Staged | null> {
  if (result.sha === null) return null
  const seen = new Map<string, VersionInfo>()
  let loser: VersionInfo | null = null
  let before: number | undefined
  for (;;) {
    const page = await client.versions(result.file_id, {
      limit: VERSION_PAGE,
      ...(before === undefined ? {} : { before }),
    })
    for (const version of page) {
      seen.set(version.version_id, version)
      if (
        sentSha !== null &&
        loser === null &&
        version.version_id !== result.version_id &&
        version.sha === sentSha
      ) {
        loser = version
      }
    }
    const last = page.at(-1)
    if (loser !== null || page.length < VERSION_PAGE || last === undefined) break
    before = last.no
  }
  const head = seen.get(result.version_id)
  // A head re-written over the loser names the device whose head it was; that is who the
  // person is told the change came from, not this device, which only sent the loser.
  const picked = head?.merge?.head_version_id
  const author = (picked === undefined ? undefined : seen.get(picked)) ?? head
  const change: ChangeItem = {
    seq: result.seq,
    file_id: result.file_id,
    op: source === result.path ? 'modify' : 'move',
    path: result.path,
    prev_path: source === result.path ? null : source,
    sha: result.sha,
    size: result.size,
    mtime: result.mtime,
    version_id: result.version_id,
    // What the file is does not decide anything about a staged change; the host stages the
    // config folder, as `goneFrom` in the puller also says.
    kind: 'settings',
    actor: author?.actor ?? { kind: 'system', id: 'server', name: 'the server' },
    at: author?.at ?? '',
  }
  return { change, base: loser?.version_id ?? fallbackBase }
}
