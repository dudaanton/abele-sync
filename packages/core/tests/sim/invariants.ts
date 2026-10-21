import { expect } from 'vitest'
import { sha256 } from '../../src/index.js'
import type { SimDevice } from './simDevice.js'

export function ownDownloads(device: SimDevice, baseline = 0) {
  expect(device.network.downloads.length - baseline, 'I3: own bytes downloaded').toBe(0)
}
export function haltedEffects(effects: number, lanes: number) {
  expect(effects, 'I4: effects after pause/stop mark').toBeLessThanOrEqual(lanes)
}
export async function ledger(device: SimDevice, head: number, versions?: ReadonlySet<string>) {
  expect(await device.state.getCursor(), 'I7: cursor beyond head').toBeLessThanOrEqual(head)
  expect(await device.state.getJournal(), 'I7: journal at quiescence').toBeNull()
  const ids = new Set<string>()
  for await (const entry of device.state.all()) {
    expect(ids.has(entry.fileId), 'I7: duplicate file identity').toBe(false)
    ids.add(entry.fileId)
    expect(await sha256(await device.fs.read(entry.path)), 'I7: ledger differs from disk').toBe(
      entry.sha
    )
    expect(
      versions
        ? versions.has(entry.versionId)
        : (await device.client.versions(entry.fileId)).some(
            (v) => v.version_id === entry.versionId
          ),
      'I7: missing version'
    ).toBe(true)
  }
}
export function stages(device: SimDevice) {
  expect(device.fs.stages.size, 'I6: orphan stage at quiescence').toBe(0)
}
export async function idle(device: SimDevice) {
  const before = {
    commits: device.network.commits.length,
    downloads: device.network.downloads.length,
    disk: device.fs.snapshot(),
  }
  const mark = device.scheduler.points.length
  await device.engine.sync()
  await device.engine.sync()
  expect(
    {
      commits: device.network.commits.length,
      downloads: device.network.downloads.length,
      disk: device.fs.snapshot(),
    },
    'I5: not idle'
  ).toEqual(before)
  expect(
    device.scheduler.points
      .slice(mark)
      .filter((p) => /^fs\.(writeAtomic|stage.commit|remove|move)#/.test(p)),
    'I5: filesystem effects while idle'
  ).toEqual([])
}
export function exactlyOnce(versions: Array<{ file_id: string; sha: string | null }>) {
  // For traces that never intentionally revisit a content identity.
  expect(
    new Set(versions.map((v) => `${v.file_id}:${v.sha}`)).size,
    'I11: duplicate version effect'
  ).toBe(versions.length)
}
