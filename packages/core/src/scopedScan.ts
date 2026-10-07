import { caseKey, normalisePath, type ScopedCommitRequest } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { ScopedState } from './scopedState.js'
import { sha256 } from './hash.js'
import { scopedPathAllowed } from './scopedSafety.js'
/** Only changed authorized identities and untracked genuine folder-native creates.
 * Missing, detached, deleted and unmaterialized files never become implicit deletes/creates.
 */
export async function scanScopedChanges(
  fs: FileSystem,
  state: ScopedState,
  prefix: string,
  configuration: readonly string[] = [],
  limit = 32
): Promise<ScopedCommitRequest['ops']> {
  const ops: ScopedCommitRequest['ops'] = [],
    store = state.placementStore(),
    knownPaths = new Set<string>()
  let notes = 0
  for (let offset = 0; ; offset += 1000) {
    const page = await state.knownPage(offset)
    for (const file of page) knownPaths.add(caseKey(file.path))
    if (page.length < 1000) break
  }
  for await (const stat of fs.list()) {
    const path = normalisePath(stat.path)
    if (!scopedPathAllowed(path, configuration)) continue
    const entry = await store.get(stat.path),
      known = entry ? await state.getKnown(entry.fileId) : null
    if (
      entry &&
      (!known || ['detached', 'deleted', 'known_not_materialized'].includes(known.state))
    )
      continue
    if (!entry && !caseKey(path).startsWith(caseKey(prefix))) continue
    // Preserve received identities even if their original tracked path moved/missing.
    if (!entry && knownPaths.has(caseKey(path))) continue
    const bytes = await fs.read(stat.path),
      sha = await sha256(bytes)
    if (entry && sha === entry.sha) continue
    if (entry && !/\.md$/i.test(path) && !known?.native) continue
    if (/\.md$/i.test(path)) {
      if (notes + bytes.length > 8 * 1024 * 1024) continue
      notes += bytes.length
    }
    if (bytes.length > 200 * 1024 * 1024) continue
    ops.push(
      entry
        ? {
            op: 'modify',
            file_id: entry.fileId,
            base_version_id: entry.versionId,
            sha,
            size: bytes.length,
            mtime: stat.mtime,
          }
        : { op: 'create', path, sha, size: bytes.length, mtime: stat.mtime }
    )
    if (ops.length >= limit) break
  }
  return ops
}
