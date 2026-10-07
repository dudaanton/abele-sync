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

describe('concurrent devices', () => {
  it('20 devices committing 10 creates each at once: 200 seqs, each once, every path unique', async () => {
    const { vaultId } = await h.vault(account)
    const devices: Device[] = []
    for (let i = 0; i < 20; i++) devices.push(await device(vaultId, `device-${i}`))
    for (const [i, d] of devices.entries()) {
      for (let j = 0; j < 10; j++) await d.write(`d${i}/note-${j}.md`, `device ${i}, note ${j}\n`)
    }

    const reports = await Promise.all(devices.map((d) => d.sync()))
    for (const r of reports) {
      expect(r.push.committed?.results.map((x) => x.status)).toEqual(Array(10).fill('applied'))
    }
    expect(devices.map((d) => d.stats.commits)).toEqual(Array(20).fill(1))

    const observer = h.clientFor(
      (await h.device(account, vaultId, 'observer')).deviceToken,
      vaultId
    )
    const state = await observer.state()
    expect(state.head_seq).toBe(200)
    const feed = await observer.changes(0, 1000)
    expect(feed.items.map((x) => x.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
    expect(feed.head_seq).toBe(200)
    const manifest = await observer.manifest(null, 1000)
    expect(new Set(manifest.items.map((x) => x.path)).size).toBe(200)
    expect(manifest.next).toBeNull()

    await converge(...devices)
    expect(devices[0]?.fs.snapshot().size).toBe(200)
  })

  it('two devices modifying one note at once with the same base: one applied, one merged, both edits kept', async () => {
    const { vaultId } = await h.vault(account)
    const a = await device(vaultId, 'a')
    const b = await device(vaultId, 'b')
    await a.write('Note.md', 'one\ntwo\nthree\n')
    await a.sync()
    await b.sync()
    expect((await a.state.get('Note.md'))?.versionId).toBe(
      (await b.state.get('Note.md'))?.versionId
    )

    await a.write('Note.md', 'ONE\ntwo\nthree\n')
    await b.write('Note.md', 'one\ntwo\nTHREE\n')
    const [ra, rb] = await Promise.all([a.sync(), b.sync()])
    const statuses = [
      ra.push.committed?.results[0]?.status,
      rb.push.committed?.results[0]?.status,
    ].sort()
    expect(statuses).toEqual(['applied', 'merged'])

    await converge(a, b)
    expect(await a.text('Note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect(await b.text('Note.md')).toBe('ONE\ntwo\nTHREE\n')
  })
})
