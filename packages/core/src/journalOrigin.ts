import { caseKey } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { Journal, StateStore } from './state.js'
import { resolveLocalFile } from './localPaths.js'

/** Head advancement alone is normal after an authored request lost its answer. */
export async function authoredJournal(
  state: StateStore,
  journal: Journal,
  fs: FileSystem
): Promise<boolean> {
  const origin = journal.origin
  const age = Date.now() - Date.parse(journal.startedAt)
  if (
    !origin ||
    !Number.isFinite(age) ||
    age < 0 ||
    age >= 24 * 60 * 60 * 1000 ||
    origin.cursor !== (await state.getCursor()) ||
    origin.generation !== ((await state.getMeta?.('server-restore-generation')) ?? null)
  )
    return false
  for (const op of journal.ops) {
    if (op.op !== 'delete' && op.op !== 'move') continue
    const entry = await state.byFileId(op.file_id)
    if (!entry) continue // Already recorded part of this same immutable journal.
    const source = await fs.stat(entry.path)
    if (op.op === 'delete') {
      if (source !== null) return false
    } else {
      const target = await resolveLocalFile(fs, state, op.to_path)
      if (
        (await fs.stat(target)) === null ||
        (source !== null && caseKey(entry.wirePath) !== caseKey(op.to_path))
      )
        return false
    }
  }
  return true
}
