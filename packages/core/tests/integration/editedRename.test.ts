import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Device } from '../helpers/device.js'
import { serverHarness, type Harness } from '../helpers/harness.js'

/**
 * A lost note and a fresh one, through the real engine and server: an edited rename only when
 * the text is clearly the same note, which the engine judges by reading the lost note's text
 * back from the server (ruling 2026-09-27). Not mirrored in the simulated tier: the pairing is
 * the engine's scanner's, which that tier does not run.
 */

let h: Harness, account: string

const device = async (name: string, vaultId: string): Promise<Device> => {
  const { deviceToken } = await h.device(account, vaultId, name)
  return new Device(h, vaultId, deviceToken, name)
}

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

describe('edited renames', () => {
  it('a note deleted and an unrelated one written go out as a delete and a create', async () => {
    const own = (await h.vault(account, 'Unrelated')).vaultId
    const editor = await device('editor', own)
    await editor.write('A.md', 'first\nsecond\nthird\n')
    await editor.sync()
    const fileId = (await editor.state.get('A.md'))?.fileId

    await editor.rm('A.md')
    await editor.write('B.md', 'a shopping list\nmilk\n')
    const pushed = (await editor.sync()).push.committed
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'applied', file_id: fileId }),
      expect.objectContaining({ status: 'applied', path: 'B.md' }),
    ])
    // B.md is a file of its own, and A.md's history stays A.md's, ending in its delete.
    expect((await editor.state.get('B.md'))?.fileId).not.toBe(fileId)
    const observer = h.clientFor((await h.device(account, own)).deviceToken, own)
    const versions = await observer.versions(fileId ?? '')
    expect(versions.map((x) => [x.op, x.path])).toEqual([
      ['delete', 'A.md'],
      ['create', 'A.md'],
    ])
  })
})
