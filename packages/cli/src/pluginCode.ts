import { createHash } from 'node:crypto'
import { caseKey, type ChangeItem } from '@abele/sync-protocol'

/** Abele's own folder keeps its existing sync policy; data.json is settings, not code. */
export function codePluginId(path: string): string | null {
  const parts = path.split('/')
  if (parts.length < 4 || caseKey(parts[0]!) !== '.obsidian' || caseKey(parts[1]!) !== 'plugins')
    return null
  const id = parts[2]!
  if (id === '' || caseKey(id) === 'abele') return null
  if (parts.length === 4 && caseKey(parts[3]!) === 'data.json') return null
  return id
}

export function codePluginIds(change: ChangeItem): string[] {
  return [
    ...new Set(
      [change.path, change.prev_path].flatMap((path) => {
        const id = path === null ? null : codePluginId(path)
        return id === null ? [] : [id]
      })
    ),
  ]
}

export interface CodeGroup {
  ids: string[]
  changes: ChangeItem[]
}

/** A cross-plugin move is one approval group: approving only its source cannot install its target. */
export function codeGroups(changes: readonly ChangeItem[]): CodeGroup[] {
  const parents = new Map<string, string>()
  const root = (id: string): string => {
    let found = id
    while (parents.has(found) && parents.get(found) !== found) found = parents.get(found)!
    while (parents.has(id) && parents.get(id) !== found) {
      const next = parents.get(id)!
      parents.set(id, found)
      id = next
    }
    return found
  }
  for (const change of changes) {
    const ids = codePluginIds(change)
    for (const id of ids) {
      if (!parents.has(id)) parents.set(id, id)
      parents.set(root(id), root(ids[0]!))
    }
  }
  const groups = new Map<string, CodeGroup>()
  for (const id of parents.keys()) {
    const key = root(id)
    const group = groups.get(key) ?? { ids: [], changes: [] }
    group.ids.push(id)
    groups.set(key, group)
  }
  for (const change of changes) {
    const first = codePluginIds(change)[0]
    if (first !== undefined) groups.get(root(first))!.changes.push(change)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, ids: group.ids.sort() }))
    .sort((a, b) => a.ids.join(',').localeCompare(b.ids.join(',')))
}

/** Bound to the exact files, versions, paths and bytes shown; never a permanent plugin allowlist. */
export function codeFingerprint(group: CodeGroup): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ids: group.ids,
        changes: [...group.changes]
          .sort((a, b) => a.file_id.localeCompare(b.file_id))
          .map((change) => ({
            file: change.file_id,
            version: change.version_id,
            path: change.path,
            from: change.prev_path,
            op: change.op,
            sha: change.sha,
            size: change.size,
            mtime: change.mtime,
          })),
      })
    )
    .digest('hex')
    .slice(0, 32)
}

export const codeHeldLine = (count: number): string =>
  `code awaiting approval: ${count} files; list with abele-sync code --dir DIR (stop the daemon before deciding)`

/** An untrusted plugin id in a command hint must not become shell substitution. */
export const codeArg = (value: string): string =>
  /^[a-zA-Z0-9_-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`

/** Render untrusted names as plain text, not terminal controls. */
export const codeText = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
