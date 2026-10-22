import { expect, it } from 'vitest'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { simServer } from './server.js'
import { SimScheduler } from './scheduler.js'
import { SimDevice } from './simDevice.js'

it('restart during first upload never downloads or rewrites equal final remote content', async () => {
  const scheduler = new SimScheduler(81),
    server = await simServer(scheduler, { memoryDatabase: true })
  const paged: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/v2/changes') url.searchParams.set('limit', '1')
    return server.fetch(url, init)
  }
  let device = new SimDevice(scheduler, server.token, paged)
  try {
    for (let n = 0; n < 6; n++) await device.write(`file-${n}.md`, `own ${n}`)
    scheduler.cut = 'net.after.POST./v2/commit#1'
    await expect(device.engine.sync()).rejects.toThrow()
    expect(scheduler.epoch).toBe(1)
    scheduler.cut = undefined
    const owner = new V2SyncClient(server.token, server.fetch)
    const original = (await owner.manifest()).items.find((item) => item.path === 'file-0.md')!
    let version = original.version_id
    // History accumulated while the device was down. Neither historical bytes nor
    // the final bytes already held by this device should be downloaded on restart.
    for (const text of ['intermediate', 'final']) {
      const blob = await owner.upload(Buffer.from(text))
      const response = await owner.commit([
        { op: 'modify', file_id: original.file_id, base_version_id: version, ...blob, mtime: 2000 },
      ])
      const result = response.results[0]!
      if (result.status !== 'applied') throw new Error('expected applied remote history')
      version = result.version_id
    }
    device = device.crash()
    // The offline editor independently reached the current remote content while
    // the unfinished first-upload receipt still describes its older submission.
    await device.write('file-0.md', 'final')
    const start = scheduler.points.length
    await device.quiesce()
    expect(device.network.downloads).toEqual([])
    expect(
      scheduler.points
        .slice(start)
        .filter((point) =>
          /^fs\.(writeAtomic|stage.commit|conditionalFile|remove|move)#/.test(point)
        )
    ).toEqual([])
    for (let n = 0; n < 6; n++)
      expect(new TextDecoder().decode(await device.fs.read(`file-${n}.md`))).toBe(
        n === 0 ? 'final' : `own ${n}`
      )
    expect(device.network.commits).toHaveLength(1)
    expect((await device.state.get('file-0.md'))?.versionId).toBe(version)
    expect(await device.state.getJournal()).toBeNull()
  } finally {
    await device.engine.stop()
    await server.close()
  }
}, 20000)
