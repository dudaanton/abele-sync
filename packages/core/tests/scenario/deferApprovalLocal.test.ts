import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { CONFIG, PLUGIN, pairOf } from '../helpers/deferPair.js'
import { Device } from '../helpers/device.js'

const MAIN = `${PLUGIN}/main.js`
let h: Harness, account: string
beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

describe('approval in a fresh engine protects local missing sources', () => {
  for (const action of ['delete', 'move'] as const) {
    it(`holds code when its tracked source was locally ${action}d after staging`, async () => {
      const { vaultId, a, b } = await pairOf(h, account, `approval ${action}`)
      await b.write(MAIN, 'remoteUpdate()')
      await b.sync()
      await a.sync()
      const shown = (await a.engine.deferred()).map((one) => one.version_id)
      if (action === 'delete') await a.rm(MAIN)
      else await a.mv(MAIN, 'Local.js')
      const again = new Device(h, vaultId, a.deviceToken, 'A', {
        fs: a.fs,
        state: a.state,
        defer: CONFIG,
      })
      const approval = await again.engine.applyDeferred(shown)
      expect(approval.applied).toEqual([])
      expect(approval.skipped).toEqual([MAIN])
      expect(again.has(MAIN)).toBe(false)
      expect((await again.engine.deferred()).map((one) => one.version_id)).toEqual(shown)
      if (action === 'move') expect(await again.text('Local.js')).toBe('main()')
    })
  }
})
