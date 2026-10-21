import { expect, it } from 'vitest'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { SimScheduler } from './scheduler.js'
import { simServer } from './server.js'
import { SimDevice } from './simDevice.js'
import { ownDownloads, haltedEffects, stages, idle, ledger, exactlyOnce } from './invariants.js'
import { SyncCancelled } from '../../src/engine.js'

it('v2 simulation converges and is idle through streaming placement', async () => {
  const scheduler = new SimScheduler(1),
    server = await simServer(scheduler)
  const device = new SimDevice(scheduler, server.token, server.fetch)
  try {
    await new V2SyncClient(server.token, server.fetch).create('remote.md', 'remote')
    await device.quiesce()
    expect(new TextDecoder().decode(await device.fs.read('remote.md'))).toBe('remote')
    stages(device)
    await idle(device)
    const head = await device.state.getCursor()
    await ledger(device, head)
  } finally {
    await device.engine.stop()
    await server.close()
  }
})

// Regression D-001 H1: a new version of identical content requires no content GET.
it('H1: a version bump with the same sha does not download', async () => {
  const scheduler = new SimScheduler(2),
    server = await simServer(scheduler)
  const device = new SimDevice(scheduler, server.token, server.fetch)
  try {
    await device.write('same.md', 'same')
    await device.quiesce()
    const entry = (await device.state.get('same.md'))!
    const owner = new V2SyncClient(server.token, server.fetch)
    await owner.commit([
      {
        op: 'modify',
        file_id: entry.fileId,
        base_version_id: entry.versionId,
        sha: entry.sha,
        size: entry.size,
        mtime: 2000,
      },
    ])
    const before = device.network.downloads.length
    await device.quiesce()
    ownDownloads(device, before)
  } finally {
    await device.engine.stop()
    await server.close()
  }
})

// Regression D-001: the applied-response cut retains the own-content guarantee.
it('T1: interrupted first upload of 2500 tiny files never pulls own bytes', async () => {
  const scheduler = new SimScheduler(3),
    server = await simServer(scheduler)
  let device = new SimDevice(scheduler, server.token, server.fetch)
  try {
    for (let n = 0; n < 2500; n++)
      await device.write(`f${String(n).padStart(4, '0')}.md`, `tiny${n}`)
    scheduler.cut = process.env.SIM_CUT ?? 'net.after.POST./v2/commit#1'
    try {
      await device.engine.sync()
    } catch (error) {
      if (scheduler.epoch === 0) throw error
    }
    expect(scheduler.points).toContain(scheduler.cut)
    expect(scheduler.epoch).toBe(1)
    scheduler.cut = undefined
    device = device.crash()
    await device.quiesce()
    stages(device)
    exactlyOnce(
      await server.db.selectFrom('versions').select(['file_id', 'blob_sha as sha']).execute()
    )
    const versions = await server.db.selectFrom('versions').select(['id', 'seq']).execute()
    expect(versions, 'I11: exactly one initial version per file').toHaveLength(2500)
    await ledger(
      device,
      Math.max(0, ...versions.map((v) => v.seq)),
      new Set(versions.map((v) => v.id))
    )
    await idle(device)
    ownDownloads(device)
  } finally {
    await device.engine.stop()
    await server.close()
  }
}, 90_000)

for (const operation of ['pause', 'stop'] as const) {
  // Regression D-002: cancellation preserves the original per-lane effect envelope.
  it(`T2: ${operation} during pull bounds effects to one per lane`, async () => {
    const scheduler = new SimScheduler(4),
      server = await simServer(scheduler)
    const device = new SimDevice(scheduler, server.token, server.fetch)
    let stopping: Promise<void> | undefined
    try {
      const owner = new V2SyncClient(server.token, server.fetch)
      for (let n = 0; n < 12; n++) await owner.create(`r${n}.md`, `remote${n}`)
      let mark = -1
      scheduler.hook = async (point) => {
        if (
          mark < 0 &&
          point.startsWith(
            operation === 'pause' ? 'fs.stage.commit#' : 'net.after.GET./v2/manifest#'
          )
        ) {
          mark = scheduler.points.length - 1
          if (operation === 'pause') device.engine.pause()
          else stopping = device.engine.stop()
        }
      }
      await expect(device.engine.sync()).rejects.toBeInstanceOf(SyncCancelled)
      await stopping
      expect(mark).toBeGreaterThanOrEqual(0)
      const effects = scheduler.points
        .slice(mark + 1)
        .filter((p) => p.startsWith('fs.stage.commit#')).length
      scheduler.hook = undefined
      if (operation === 'pause') device.engine.resume()
      await device.quiesce()
      stages(device)
      await idle(device)
      haltedEffects(effects, 4)
    } finally {
      scheduler.hook = undefined
      await device.engine.stop()
      await server.close()
    }
  })
}
