import {
  scan,
  StagedChanges,
  type FileSystem,
  type ScanFilter,
  type StateStore,
} from '@abele/sync-core'
import { codePluginId, type CodeGroup } from './pluginCode.js'

/** Approval is not a sync: read the current disk against the ledger from before preparation. */
export async function localCodeChanges(
  group: CodeGroup,
  vault: { fs: FileSystem; state: StateStore; filter: ScanFilter }
): Promise<string[]> {
  const found = await scan(vault.fs, vault.state, vault.filter)
  const records = new Map(
    (await new StagedChanges(vault.state).list()).map((one) => [one.change.file_id, one])
  )
  const ids = new Set(group.ids)
  const paths = new Set(group.changes.flatMap((one) => [one.path, one.prev_path]))
  const changed = new Set<string>()
  for (const op of found.ops) {
    const entry = op.op === 'create' ? null : await vault.state.byFileId(op.file_id)
    const settled = op.op === 'delete' ? records.get(op.file_id)?.settled : undefined
    if (settled?.sha === null && settled.path === entry?.path) continue
    for (const path of [
      entry?.wirePath,
      op.op === 'create' ? op.path : op.op === 'move' ? op.to_path : null,
    ]) {
      if (path != null && (paths.has(path) || ids.has(codePluginId(path) ?? ''))) changed.add(path)
    }
  }
  return [...changed]
}
