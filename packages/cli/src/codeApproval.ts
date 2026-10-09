import {
  DEFERRED_KEY,
  EngineError,
  MemoryStateStore,
  type DeferredApplied,
  type SyncEngine,
} from '@abele/sync-core'
import { caseKey } from '@abele/sync-protocol'
import { localCodeChanges } from './codeCheck.js'
import { CodeDraft } from './codeDraft.js'
import { CodeGroupDisk } from './codeGroupDisk.js'
import { codePluginId, type CodeGroup } from './pluginCode.js'
import { buildEngine, DEFAULT_INTERVAL_SECONDS, type OpenVault } from './vault.js'

class HeldGroup extends Error {}

/** Prepare everything off-vault, then revalidate and commit the entire group or none of it. */
export async function approveCodeGroup(
  vault: OpenVault,
  group: CodeGroup,
  held: () => boolean,
  log: (line: string) => void
): Promise<DeferredApplied> {
  const baseline = new MemoryStateStore()
  for await (const entry of vault.state.all()) await baseline.put(entry)
  await baseline.setMeta(DEFERRED_KEY, vault.state.getMeta(DEFERRED_KEY))
  const disk = await CodeGroupDisk.create(vault, held)
  const running: { engine: SyncEngine | null } = { engine: null }
  let result: DeferredApplied
  const lines: string[] = []
  try {
    result = await vault.state.transaction(async () => {
      if ((await vault.state.getJournal()) !== null)
        throw new HeldGroup('finish the interrupted sync before approval')
      const draft = await CodeDraft.create(vault.fs, disk.work, {
        effectGuard: () => {
          vault.fence?.assertOwner()
          if (!held()) throw new EngineError('lost', 'code approval ownership lost')
        },
        effectTracker: vault.fence?.track,
      })
      const paths = new Set(
        group.changes.flatMap((one) => [
          one.path,
          ...(one.prev_path === null ? [] : [one.prev_path]),
        ])
      )
      const folded = new Set([...paths].map(caseKey))
      const files = new Set(group.changes.map((one) => one.file_id))
      // Load source spellings before targets, including case/NFC aliases, before any virtual move.
      for await (const entry of baseline.all()) {
        if (
          files.has(entry.fileId) ||
          folded.has(caseKey(entry.wirePath)) ||
          group.ids.includes(codePluginId(entry.wirePath) ?? '')
        ) {
          await draft.preload([entry.path])
        }
      }
      await draft.preload(paths)
      const engine = (running.engine = buildEngine(
        { ...vault, fs: draft },
        {
          stillHeld: held,
          fallbackMs: DEFAULT_INTERVAL_SECONDS * 1000,
          log: (line) => lines.push(line),
        }
      ))
      await engine.recordScope()
      const prepared = await engine.applyDeferred(group.changes.map((one) => one.version_id))
      await engine.stop()
      running.engine = null
      if (prepared.skipped.length > 0 || prepared.applied.length !== group.changes.length) {
        throw new HeldGroup('a member could not be prepared')
      }
      // The transaction's ledger now describes the draft. Use the ORIGINAL ledger for this scan.
      if (
        (await localCodeChanges(group, { ...vault, state: baseline })).length > 0 ||
        !(await draft.validate())
      ) {
        throw new HeldGroup('local code changed while downloading the group')
      }
      await disk.place(draft)
      return prepared
    })
  } catch (error) {
    // SQL rolled every entry and queued version back. Roll back any attempted filesystem steps
    // too; a lost lock or conflicting external edit retains the undo journal for the next holder.
    await running.engine?.stop()
    await disk.rollback()
    await disk.discard()
    if (error instanceof HeldGroup) {
      log(`code: whole group still held: ${error.message}`)
      return { applied: [], skipped: group.changes.map((one) => one.path) }
    }
    throw error
  }
  // Never roll a committed transaction back because cleanup failed. Its marker lets recovery
  // discard the backups without reinstalling code or undoing later local edits.
  await disk.discard()
  for (const line of lines) log(line)
  return result
}
