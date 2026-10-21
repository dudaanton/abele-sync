import { expect } from 'vitest'
import { sha256 } from '../../src/index.js'
import type { V2ManifestItem } from '@abele/sync-protocol'
import type { SimDevice } from './simDevice.js'

/** Independent content oracle; server manifest is authority only after quiescence. */
export async function converged(device: SimDevice, manifest: V2ManifestItem[]) {
  const expected = manifest
    .filter((i) => i.kind !== 'directory')
    .map((i) => ({ path: i.path, sha: 'sha' in i ? i.sha : '', size: 'size' in i ? i.size : 0 }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const actual = await Promise.all(
    [...device.fs.snapshot()].map(async ([path, bytes]) => ({
      path,
      sha: await sha256(bytes),
      size: bytes.length,
    }))
  )
  actual.sort((a, b) => a.path.localeCompare(b.path))
  expect(actual, 'I5: disk differs from server manifest').toEqual(expected)
}
