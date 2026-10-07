import type { CommitOp } from '@abele/sync-protocol'
import { shaIndex } from './apply.js'
import type { FileSystem } from './fs.js'
import type { ScanResult } from './scanner.js'
import type { StateStore } from './state.js'

/**
 * Where an upload finds the bytes it wants on this disk: where the scan found each sha, or, for
 * a journal replayed with no scan, where its ops and the state say each one should be.
 */

/** The bytes an upload wants, from this disk: null when this device cannot find them. */
export interface Sources {
  bytes(sha: string): Promise<Uint8Array | null>
}

/** Where the scan found each sha. The scan hashed those very bytes, so it is the best index. */
export function sourcesFromScan(fs: FileSystem, scan: ScanResult): Sources {
  const paths = new Map<string, string>()
  for (const [wirePath, sha] of scan.hashes) {
    if (!paths.has(sha)) paths.set(sha, scan.diskPaths.get(wirePath) ?? wirePath)
  }
  return sourcesAt(fs, paths)
}

/**
 * Where a journal's ops say each sha should be: a create names its own path, and anything
 * else names a file the state knows — at the path a move in the same batch gave it, if one
 * did. A sha no op accounts for is looked for among the files already synced.
 */
export async function sourcesFromOps(
  fs: FileSystem,
  state: StateStore,
  ops: CommitOp[]
): Promise<Sources> {
  const moved = new Map<string, string>()
  for (const op of ops) if (op.op === 'move') moved.set(op.file_id, op.to_path)

  const paths = new Map<string, string>()
  for (const op of ops) {
    if (!('sha' in op) || paths.has(op.sha)) continue
    if (op.op === 'create') {
      paths.set(op.sha, op.path)
      continue
    }
    const at = moved.get(op.file_id) ?? (await state.byFileId(op.file_id))?.path
    if (at !== undefined) paths.set(op.sha, at)
  }
  for (const [sha, entry] of await shaIndex(state)) {
    if (!paths.has(sha)) paths.set(sha, entry.path)
  }
  return sourcesAt(fs, paths)
}

/**
 * The bytes at the path a sha was found under. They are not hashed again on the way out:
 * the server refuses anything that does not hash to the name it was sent under, and
 * `upload` treats that refusal as a file that has changed since the scan.
 */
const sourcesAt = (fs: FileSystem, paths: Map<string, string>): Sources => ({
  bytes: async (sha) => {
    const path = paths.get(sha)
    if (path === undefined) return null
    try {
      return await fs.read(path)
    } catch {
      // The file went between the scan and the upload. The commit will say so.
      return null
    }
  },
})
