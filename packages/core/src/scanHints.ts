import type { FileInfo } from './fs.js'
import type { StateStore } from './state.js'

export const scanHintKey = (path: string) => `scan-hint:${encodeURIComponent(path)}`
export async function scanHintEpoch(state: StateStore): Promise<string> {
  return JSON.stringify([
    (await state.getMeta?.('server-restore-generation')) ?? null,
    (await state.getMeta?.('scan-hint-epoch')) ?? null,
  ])
}
export async function readScanHint(
  state: StateStore,
  info: FileInfo,
  epoch: string
): Promise<string | null> {
  const raw = await state.getMeta?.(scanHintKey(info.path))
  if (!raw) return null
  try {
    const hint = JSON.parse(raw) as { epoch: string; size: number; mtime: number; sha: string }
    return hint.epoch === epoch &&
      hint.size === info.size &&
      hint.mtime === info.mtime &&
      /^[a-f0-9]{64}$/.test(hint.sha)
      ? hint.sha
      : null
  } catch {
    return null
  }
}
export async function writeScanHint(state: StateStore, info: FileInfo, epoch: string, sha: string) {
  await state.setMeta?.(
    scanHintKey(info.path),
    JSON.stringify({ epoch, size: info.size, mtime: info.mtime, sha })
  )
}
