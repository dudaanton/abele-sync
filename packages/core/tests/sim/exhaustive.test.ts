import { expect, it } from 'vitest'
import { SimScheduler } from './scheduler.js'
import { simServer } from './server.js'
import { SimDevice } from './simDevice.js'
import { idle, ledger, ownDownloads, stages, exactlyOnce } from './invariants.js'

/** Run on the sweep machine: baseline records points, each cut gets a fresh server/disk. */
async function upload(cut?: string) {
  const scheduler = new SimScheduler(31),
    server = await simServer(scheduler)
  let device = new SimDevice(scheduler, server.token, server.fetch)
  try {
    for (let n = 0; n < Number(process.env.SIM_FILES ?? 2500); n++)
      await device.write(`tiny${n}.md`, `bytes${n}`)
    scheduler.cut = cut
    try {
      await device.engine.sync()
    } catch (error) {
      if (!cut || scheduler.epoch === 0) throw error
    }
    const points = scheduler.points.slice()
    if (cut) {
      expect(points).toContain(cut)
      scheduler.cut = undefined
      device = device.crash()
      await device.quiesce()
      stages(device)
      const versions = await server.db.selectFrom('versions').select(['id', 'seq']).execute()
      await ledger(
        device,
        Math.max(0, ...versions.map((v) => v.seq)),
        new Set(versions.map((v) => v.id))
      )
      exactlyOnce(
        await server.db.selectFrom('versions').select(['file_id', 'blob_sha as sha']).execute()
      )
      await idle(device)
      ownDownloads(device)
    }
    return points
  } finally {
    await device.engine.stop()
    await server.close()
  }
}

// BUG: D-001: crash sweep retains the own-content guarantee while product recovery is fixed.
it.skipIf(process.env.SIM_EXHAUSTIVE !== '1').fails(
  'sweeps every recorded push adapter boundary',
  async () => {
    const points = await upload()
    const first = points.findIndex((p) => p.startsWith('net.before.PUT./v2/uploads'))
    expect(first).toBeGreaterThanOrEqual(0)
    const failures: Array<{ cut: string; error: string }> = []
    for (const cut of points.slice(first)) {
      try {
        await upload(cut)
      } catch (error) {
        failures.push({ cut, error: error instanceof Error ? error.message : String(error) })
      }
    }
    expect(failures, 'I3/I5/I6/I7/I11 crash sweep').toEqual([])
  },
  Number(process.env.SIM_TIMEOUT ?? 7_200_000)
)
