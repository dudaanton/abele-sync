import type { StateStore } from './state.js'

export const DEPARTURE_MARK = 'v2-departure-path:'
export const AUTHORED_MARK = 'v2-authored-departure-path:'
const markKey = (prefix: string, path: string) => prefix + 'p:' + encodeURIComponent(path)
interface Mark {
  present: boolean
  next: string | null
}
interface Index {
  first: string
  last: string
}

/** A linked baseline index needs only legacy getMeta/setMeta capabilities. */
export async function writeDepartureMark(
  state: StateStore,
  prefix: string,
  path: string,
  present: boolean
) {
  const key = markKey(prefix, path)
  const raw = await state.getMeta!(key)
  if (raw !== null) {
    const row = JSON.parse(raw) as Mark
    if (row.present !== present) await state.setMeta!(key, JSON.stringify({ ...row, present }))
    return
  }
  const rawIndex = await state.getMeta!(prefix + 'index')
  const index = rawIndex === null ? null : (JSON.parse(rawIndex) as Index)
  await state.setMeta!(key, JSON.stringify({ present, next: null }))
  if (index) {
    const lastKey = markKey(prefix, index.last)
    const last = JSON.parse((await state.getMeta!(lastKey))!) as Mark
    await state.setMeta!(lastKey, JSON.stringify({ ...last, next: path }))
  }
  await state.setMeta!(
    prefix + 'index',
    JSON.stringify({ first: index?.first ?? path, last: path })
  )
}

export async function departureMarkKeys(state: StateStore, prefix: string): Promise<string[]> {
  const raw = await state.getMeta?.(prefix + 'index')
  if (raw == null) return []
  const index = JSON.parse(raw) as Index
  const keys = [prefix + 'index'],
    seen = new Set<string>()
  let path: string | null = index.first
  while (path !== null) {
    if (typeof path !== 'string' || seen.has(path))
      throw new Error('invalid departure membership index')
    seen.add(path)
    const key = markKey(prefix, path)
    keys.push(key)
    const raw = await state.getMeta!(key)
    if (raw === null) throw new Error('missing departure membership mark')
    const row = JSON.parse(raw) as Mark
    if (typeof row.present !== 'boolean' || !(row.next === null || typeof row.next === 'string'))
      throw new Error('invalid departure membership mark')
    path = row.next
  }
  return keys
}

/** Membership baseline, not a work scheduler. Per-path overrides retain compatibility
 * with legacy arrays without rewriting or deleting those arrays on each event. */
export async function loadDepartureMarks(state: StateStore, prefix: string, paths: Set<string>) {
  for (const key of (await departureMarkKeys(state, prefix)).slice(1)) {
    const row = JSON.parse((await state.getMeta!(key))!) as Mark
    const path = decodeURIComponent(key.slice(prefix.length + 2))
    if (row.present) paths.add(path)
    else paths.delete(path)
  }
}
