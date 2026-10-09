import { normalisePath, validatePath, type ChangeItem } from '@abele/sync-protocol'
import { ExpectedWrites } from './echo.js'
import { ExternalStateError } from './external/state.js'
import { sha256 } from './hash.js'
import type { FileSystem } from './fs.js'
import { PullPlacer } from './pullPlace.js'
import type { StateEntry, StateStore } from './state.js'

interface Intent {
  owner?: string
  fileId: string
  versionId: string
  wirePath: string
  sha: string | null
  size: number | null
  mtime: number | null
  target: string
  from: string | null
  base: StateEntry | null
}
/** Read the existing normal-pull intent, never synthesize one from matching content. */
export function decodePullIntent(raw: string, fileId: string): Intent {
  try {
    const value = JSON.parse(raw) as Intent
    if (value?.owner !== undefined && (typeof value.owner !== 'string' || !value.owner || value.owner.length > 128)) throw new Error('invalid intent owner')
    if (
      !value ||
      value.fileId !== fileId ||
      typeof value.versionId !== 'string' ||
      !value.versionId ||
      typeof value.target !== 'string' ||
      typeof value.wirePath !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha ?? '') ||
      !Number.isSafeInteger(value.size) ||
      (value.size as number) < 0 ||
      !Number.isSafeInteger(value.mtime) ||
      (value.mtime as number) < 0 ||
      !(value.from === null || typeof value.from === 'string') ||
      !(value.base === null || typeof value.base === 'object')
    )
      throw new Error('invalid intent')
    validatePath(value.wirePath)
    validatePath(normalisePath(value.target))
    if (value.from !== null) validatePath(normalisePath(value.from))
    if (
      value.base !== null &&
      (value.base.fileId !== fileId ||
        typeof value.base.path !== 'string' ||
        typeof value.base.wirePath !== 'string' ||
        typeof value.base.versionId !== 'string' ||
        !value.base.versionId ||
        !/^[a-f0-9]{64}$/.test(value.base.sha) ||
        !Number.isSafeInteger(value.base.size) ||
        value.base.size < 0 ||
        !Number.isSafeInteger(value.base.mtime) ||
        value.base.mtime < 0)
    )
      throw new Error('invalid base')
    if (value.base) {
      validatePath(value.base.wirePath)
      validatePath(normalisePath(value.base.path))
    }
    return value
  } catch (cause) {
    throw new ExternalStateError('recovery-required', { cause })
  }
}
/** Metadata-only recovery of already-recorded normal pull writes. Never installs,
 * overwrites, renames or removes a file. The established PullPlacer provenance check
 * requires this exact intent AND its still-current pre-write ledger base.
 */
export async function recoverPendingPullWrites(
  fs: FileSystem,
  state: StateStore,
  fileIds: readonly string[]
): Promise<void> {
  const placer = new PullPlacer(
    {
      getBlob: async () => {
        throw new ExternalStateError('recovery-required')
      },
    },
    fs,
    state,
    { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
    sha256
  )
  for (const fileId of fileIds) {
    const raw = await state.getMeta?.(`pull-write:${fileId}`)
    if (raw == null) continue
    const intent = decodePullIntent(raw, fileId),
      entry = await state.byFileId(fileId)
    const change: ChangeItem = {
      seq: 1,
      file_id: fileId,
      version_id: intent.versionId,
      path: intent.wirePath,
      op: intent.from === null ? 'modify' : 'move',
      prev_path: intent.from,
      sha: intent.sha,
      size: intent.size,
      mtime: intent.mtime,
      kind: 'attachment',
      actor: { kind: 'system', id: 'recovery', name: 'recovery' },
      at: '',
    }
    if (
      entry?.versionId === intent.versionId &&
      entry.wirePath === intent.wirePath &&
      entry.path === intent.target &&
      entry.sha === intent.sha &&
      entry.size === intent.size
    ) {
      await placer.pending.settled(change)
      continue
    }
    if ((await placer.pending.matching(change, entry)) === null)
      throw new ExternalStateError('recovery-required')
    await placer.adopt(change, entry)
    // adopt either recorded the completed installation or preserved both local bytes
    // and the earlier base, retiring only a definite not-written intent.
    if ((await state.getMeta?.(`pull-write:${fileId}`)) != null)
      throw new ExternalStateError('recovery-required')
  }
}
