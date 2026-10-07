import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { CONFIG, PLUGIN, pairOf } from '../helpers/deferPair.js'
import { Device } from '../helpers/device.js'

const MAIN = `${PLUGIN}/main.js`
const MOVED = '.obsidian/plugins/renamed/main.js'
let h: Harness, account: string
beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

/** A process restart must not turn a pending confirmation into installation. */
const restart = (vaultId: string, a: Device) =>
  new Device(h, vaultId, a.deviceToken, 'A', {
    fs: a.fs,
    state: a.state,
    defer: CONFIG,
  })

describe('push verdicts cannot bypass staging', () => {
  it('stages a losing local delete instead of downloading code and keeps the hold across restart', async () => {
    const { vaultId, a, b } = await pairOf(h, account, 'staged losing delete')
    await a.rm(MAIN)
    await b.write(MAIN, 'remoteUpdate()')
    await b.sync()
    const report = await a.sync()
    expect(report.push.merged).toBe(1)
    expect(a.has(MAIN)).toBe(false)
    expect(await a.engine.deferred()).toEqual([expect.objectContaining({ path: MAIN })])
    const again = restart(vaultId, a)
    expect((await again.sync()).push.committed).toBeNull()
    expect(again.has(MAIN)).toBe(false)
    const shown = (await again.engine.deferred()).map((one) => one.version_id)
    expect((await again.engine.applyDeferred(shown)).applied).toEqual([MAIN])
    expect(await again.text(MAIN)).toBe('remoteUpdate()')
    await again.assertStateMatchesDisk()
  })

  it('rejecting code after a losing delete preserves absence without deleting the remote code', async () => {
    const { a, b, seeder } = await pairOf(h, account, 'reject losing delete')
    await a.rm(MAIN)
    await b.write(MAIN, 'remoteUpdate()')
    await b.sync()
    await a.sync()
    expect(a.has(MAIN)).toBe(false)
    await a.engine.keepLocal(
      [MAIN],
      (await a.engine.deferred()).map((one) => one.version_id)
    )
    expect((await a.sync()).push.committed).toBeNull()
    expect(a.has(MAIN)).toBe(false)
    expect((await seeder.manifest(null)).items.some((one) => one.path === MAIN)).toBe(true)
  })

  for (const winner of ['local', 'remote'] as const) {
    it(`stages a server move before placement when the ${winner} edit wins`, async () => {
      const { vaultId, a, b } = await pairOf(h, account, `staged move ${winner}`)
      if (winner === 'remote') await a.write(MAIN, 'localUpdate()')
      await b.mv(MAIN, MOVED)
      await b.sync()
      await b.write(MOVED, 'remoteUpdate()')
      await b.sync()
      if (winner === 'local') await a.write(MAIN, 'localUpdate()')
      const report = await a.sync()
      expect(report.push.committed).not.toBeNull()
      expect(await a.text(MAIN)).toBe('localUpdate()')
      expect(a.has(MOVED)).toBe(false)
      expect(await a.engine.deferred()).toEqual([
        expect.objectContaining({ path: MOVED, prev_path: MAIN }),
      ])
      const again = restart(vaultId, a)
      expect((await again.sync()).push.committed).toBeNull()
      expect(again.has(MOVED)).toBe(false)
      expect(await again.text(MAIN)).toBe('localUpdate()')
      const shown = (await again.engine.deferred()).map((one) => one.version_id)
      expect((await again.engine.applyDeferred(shown)).applied).toEqual([MOVED])
      expect(again.has(MAIN)).toBe(false)
      expect(await again.text(MOVED)).toBe(winner === 'local' ? 'localUpdate()' : 'remoteUpdate()')
      await again.assertStateMatchesDisk()
    })
  }

  it('never places an accepted-unchanged move into plugin code even when the target is excluded', async () => {
    const { a, b } = await pairOf(h, account, 'excluded code placement', {
      'Local.js': 'original()',
    })
    a.selective.settings.communityPlugins = false
    await b.mv('Local.js', MOVED)
    await b.sync()
    await a.write('Local.js', 'localUpdate()')
    const report = await a.sync()
    expect(report.push.committed).not.toBeNull()
    expect(a.has(MOVED)).toBe(false)
  })

  it('rejecting a changed plugin move keeps the local code without deleting the remote plugin', async () => {
    const { a, b, seeder } = await pairOf(h, account, 'reject changed plugin move')
    await b.mv(MAIN, MOVED)
    await b.sync()
    await b.write(MOVED, 'remoteUpdate()')
    await b.sync()
    await a.sync()
    await a.engine.keepLocal(
      [MAIN, MOVED],
      (await a.engine.deferred()).map((one) => one.version_id)
    )
    await a.sync()
    expect(await a.text(MAIN)).toBe('main()')
    expect(a.has(MOVED)).toBe(false)
    expect((await seeder.manifest(null)).items.some((one) => one.path === MOVED)).toBe(true)
    expect(await seeder.trash()).toEqual([])
  })

  it('does not undo a refused local move back into a plugin without approval', async () => {
    const { vaultId, a, b, seeder } = await pairOf(h, account, 'rejected code move')
    await a.mv(MAIN, 'Local.js')
    await b.mv(MAIN, MOVED)
    await b.sync()
    const report = await a.sync()
    expect(report.push.rejected).toHaveLength(1)
    expect(await a.text('Local.js')).toBe('main()')
    expect(a.has(MAIN)).toBe(false)
    expect(a.has(MOVED)).toBe(false)
    expect(await a.engine.deferred()).toEqual([expect.objectContaining({ path: MOVED })])

    const shown = (await a.engine.deferred()).map((one) => one.version_id)
    await a.engine.keepLocal([MAIN, MOVED], shown)
    expect(await a.engine.deferred()).toEqual([])
    const again = restart(vaultId, a)
    const after = await again.sync()
    expect(after.push.rejected).toEqual([])
    expect(after.push.applied).toBe(1)
    expect(await again.text('Local.js')).toBe('main()')
    expect(again.has(MAIN)).toBe(false)
    expect(again.has(MOVED)).toBe(false)
    expect((await again.sync()).push.committed).toBeNull()
    expect(await again.engine.deferred()).toEqual([])
    const paths = (await seeder.manifest(null)).items.map((one) => one.path)
    expect(paths).toContain('Local.js')
    expect(paths).toContain(MOVED)
    expect(await seeder.trash()).toEqual([])
    await again.assertStateMatchesDisk()
  })

  it('holds a moved server head when retention removed the version containing the local bytes', async () => {
    const { vaultId, a, b } = await pairOf(h, account, 'missing staged history')
    const old = await a.state.get(MAIN)
    await b.write(MAIN, 'remoteUpdate()')
    await b.sync()
    await h.db.deleteFrom('versions').where('id', '=', old!.versionId).execute()
    await a.mv(MAIN, MOVED)
    await a.sync()
    expect(await a.text(MOVED)).toBe('main()')
    expect(await a.engine.deferred()).toEqual([expect.objectContaining({ path: MOVED })])
    const again = restart(vaultId, a)
    expect((await again.sync()).push.committed).toBeNull()
    expect(await again.text(MOVED)).toBe('main()')
    const shown = (await again.engine.deferred()).map((one) => one.version_id)
    expect((await again.engine.applyDeferred(shown)).applied).toEqual([MOVED])
    expect(await again.text(MOVED)).toBe('remoteUpdate()')
    await again.assertStateMatchesDisk()
  })
})
