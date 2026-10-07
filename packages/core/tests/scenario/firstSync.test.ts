import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge } from '../helpers/device.js'

let h: Harness, account: string

const device = async (vaultId: string, name: string): Promise<Device> => {
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

describe('first sync of a device that already has files', () => {
  it('links equal files without upload, resolves same-path differences as create vs create, and ends with everything on both', async () => {
    const { vaultId } = await h.vault(account)
    const laptop = await device(vaultId, 'laptop')
    const sameImage = randomBytes(48)
    await laptop.write('Same.md', 'the same note\n')
    await laptop.write('same.png', sameImage)
    await laptop.write('Diff.md', 'laptop wrote this\n')
    await laptop.write('diff.png', randomBytes(48), 10)
    await laptop.write('Only on the laptop.md', 'laptop only\n')
    await laptop.sync()

    const newcomer = await device(vaultId, 'newcomer')
    const newerImage = randomBytes(48)
    await newcomer.write('Same.md', 'the same note\n')
    await newcomer.write('same.png', sameImage)
    await newcomer.write('Diff.md', 'newcomer wrote this\n')
    await newcomer.write('diff.png', newerImage, 20)
    await newcomer.write('Only on the newcomer.md', 'newcomer only\n')

    const pushed = (await newcomer.sync()).push.committed
    // The scanner sends creates in path order, where the sim sent them in the order they were written.
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'merged', path: 'Diff.md' }),
      expect.objectContaining({ status: 'applied', path: 'Only on the newcomer.md' }),
      expect.objectContaining({ status: 'applied', path: 'diff.png' }),
    ])
    // The two equal files linked to the server's without a byte moving either way.
    expect((await newcomer.state.get('Same.md'))?.fileId).toBe(
      (await laptop.state.get('Same.md'))?.fileId
    )
    expect((await newcomer.state.get('same.png'))?.fileId).toBe(
      (await laptop.state.get('same.png'))?.fileId
    )
    // Uploads: the three unique blobs; downloads: the laptop-only note and the merged text.
    expect(newcomer.stats).toEqual({ blobPuts: 3, blobHeads: 3, blobGets: 2, commits: 1 })

    await converge(laptop, newcomer)
    for (const d of [laptop, newcomer]) {
      expect(d.paths()).toEqual([
        'Diff.md',
        'Only on the laptop.md',
        'Only on the newcomer.md',
        'Same.md',
        'diff.png',
        'same.png',
      ])
      expect(await d.text('Diff.md')).toBe('laptop wrote this\nnewcomer wrote this\n')
      expect(await d.holds('diff.png', newerImage)).toBe(true)
      expect(await d.holds('same.png', sameImage)).toBe(true)
    }
    expect(laptop.stats.blobGets).toBe(3)
  })
})
