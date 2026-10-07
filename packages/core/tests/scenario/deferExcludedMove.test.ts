import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { CONFIG, PLUGIN, pairOf } from '../helpers/deferPair.js'
import { Device } from '../helpers/device.js'

const MAIN = `${PLUGIN}/main.js`
const BACKUP = 'Backup/main.js'
let h: Harness, account: string
beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

for (const walk of ['feed', 'manifest'] as const) {
  describe(`deferred move to an excluded folder via ${walk}`, () => {
    for (const decision of ['approve', 'reject'] as const) {
      it(`keeps installed code and the pending decision across restart until ${decision}`, async () => {
        const { vaultId, a, b, seeder } = await pairOf(
          h,
          account,
          `excluded move ${walk} ${decision}`
        )
        a.selective.excludedFolders = ['Backup']
        await a.sync()
        const before = await a.state.get(MAIN)
        await b.mv(MAIN, BACKUP)
        await b.sync()
        // A later modify hides the move in the feed/manifest; the local entry still names its source.
        await b.write(BACKUP, 'remoteUpdate()')
        await b.sync()
        await (walk === 'feed' ? a.sync() : a.rescan())
        expect(await a.text(MAIN)).toBe('main()')
        expect(a.has(BACKUP)).toBe(false)
        expect(await a.state.get(MAIN)).toEqual(before)
        expect(await a.engine.deferred()).toEqual([
          expect.objectContaining({ path: BACKUP, prev_path: MAIN }),
        ])

        const again = new Device(h, vaultId, a.deviceToken, 'A', {
          fs: a.fs,
          state: a.state,
          selective: a.selective,
          defer: CONFIG,
        })
        expect((await again.sync()).push.committed).toBeNull()
        expect(await again.text(MAIN)).toBe('main()')
        const shown = (await again.engine.deferred()).map((one) => one.version_id)
        expect(shown).toHaveLength(1)
        if (decision === 'approve') {
          expect((await again.engine.applyDeferred(shown)).applied).toEqual([BACKUP])
          expect(again.has(MAIN)).toBe(false)
        } else {
          await again.engine.keepLocal([MAIN, BACKUP], shown)
          expect(await again.text(MAIN)).toBe('main()')
        }
        await again.sync()
        expect(again.has(BACKUP)).toBe(false)
        expect(await again.engine.deferred()).toEqual([])
        expect((await again.sync()).push.committed).toBeNull()
        expect((await seeder.manifest(null)).items.some((one) => one.path === BACKUP)).toBe(true)
        expect(await seeder.trash()).toEqual([])
        await again.assertStateMatchesDisk()
      })
    }
  })
}
