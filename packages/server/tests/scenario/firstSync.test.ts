import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { SimDevice, converge } from './sim.js'

let t: TestApp, account: string

const sim = async (vaultId: string, name: string): Promise<SimDevice> => {
  const { deviceToken } = await t.device(account, vaultId, name)
  return new SimDevice(t.app, vaultId, deviceToken, name)
}

beforeAll(async () => {
  t = await buildTestApp()
  account = (await t.account()).accountToken
})
afterAll(async () => {
  await t.close()
})

describe('first sync of a device that already has files', () => {
  it('links equal files without upload, resolves same-path differences as create vs create, and ends with everything on both', async () => {
    const { vaultId } = await t.vault(account)
    const laptop = await sim(vaultId, 'laptop')
    const sameImage = randomBytes(48)
    laptop.write('Same.md', 'the same note\n')
    laptop.write('same.png', sameImage)
    laptop.write('Diff.md', 'laptop wrote this\n')
    laptop.write('diff.png', randomBytes(48), 10)
    laptop.write('Only on the laptop.md', 'laptop only\n')
    await laptop.sync()

    const newcomer = await sim(vaultId, 'newcomer')
    const newerImage = randomBytes(48)
    newcomer.write('Same.md', 'the same note\n')
    newcomer.write('same.png', sameImage)
    newcomer.write('Diff.md', 'newcomer wrote this\n')
    newcomer.write('diff.png', newerImage, 20)
    newcomer.write('Only on the newcomer.md', 'newcomer only\n')

    const pushed = await newcomer.sync()
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'merged', path: 'Diff.md' }),
      expect.objectContaining({ status: 'applied', path: 'diff.png' }),
      expect.objectContaining({ status: 'applied', path: 'Only on the newcomer.md' }),
    ])
    // The two equal files linked to the server's without a byte moving either way.
    expect(newcomer.state.get('Same.md')?.fileId).toBe(laptop.state.get('Same.md')?.fileId)
    expect(newcomer.state.get('same.png')?.fileId).toBe(laptop.state.get('same.png')?.fileId)
    // Uploads: the three unique blobs; downloads: the laptop-only note and the merged text.
    expect(newcomer.stats).toEqual({ blobPuts: 3, blobHeads: 3, blobGets: 2, commits: 1 })

    await converge(laptop, newcomer)
    for (const d of [laptop, newcomer]) {
      expect([...d.disk.keys()].sort()).toEqual([
        'Diff.md',
        'Only on the laptop.md',
        'Only on the newcomer.md',
        'Same.md',
        'diff.png',
        'same.png',
      ])
      expect(d.text('Diff.md')).toBe('laptop wrote this\nnewcomer wrote this\n')
      expect(d.disk.get('diff.png')?.content.equals(newerImage)).toBe(true)
      expect(d.disk.get('same.png')?.content.equals(sameImage)).toBe(true)
    }
    expect(laptop.stats.blobGets).toBe(3)
  })
})
