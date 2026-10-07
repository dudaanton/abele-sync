import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryFileSystem, encodeText } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { CONFIG, PLUGIN, pairOf } from '../helpers/deferPair.js'
import { Device, nextMtime } from '../helpers/device.js'

const MAIN = `${PLUGIN}/main.js`
let h: Harness, account: string
beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

/** A file may disappear just after a read-only equality probe, before placement begins. */
function removeAfterRead(fs: MemoryFileSystem): void {
  const read = fs.read.bind(fs)
  let once = true
  fs.read = async (path) => {
    const bytes = await read(path)
    if (once && path === MAIN) {
      once = false
      await fs.remove(path)
    }
    return bytes
  }
}

describe('a staging equality probe is not write permission', () => {
  it('does not reinstall code that disappeared after the pull in-place probe', async () => {
    const { vaultId } = await pairOf(h, account, 'pull probe race')
    const fs = new MemoryFileSystem()
    await fs.writeAtomic(MAIN, encodeText('main()'), nextMtime())
    const c = new Device(h, vaultId, (await h.device(account, vaultId, 'C')).deviceToken, 'C', {
      fs,
      defer: CONFIG,
    })
    removeAfterRead(fs)
    await c.sync()
    expect(c.has(MAIN)).toBe(false)
    expect((await c.engine.deferred()).map((one) => one.path)).toContain(MAIN)
  })

  it('does not reinstall code that disappeared after the push in-place probe', async () => {
    const { a, b } = await pairOf(h, account, 'push probe race')
    await a.rm(MAIN)
    await b.write(MAIN, 'remoteUpdate()')
    await b.sync()
    const send = a.client.commitRaw.bind(a.client)
    a.client.commitRaw = async (...args) => {
      const answer = await send(...args)
      await a.write(MAIN, 'remoteUpdate()')
      removeAfterRead(a.fs)
      return answer
    }
    await a.sync()
    expect(a.has(MAIN)).toBe(false)
    expect((await a.engine.deferred()).map((one) => one.path)).toContain(MAIN)
  })
})
