import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { ChangesResponse, ManifestResponse, VaultState } from '@abele/sync-protocol'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
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

describe('concurrent devices', () => {
  it('20 devices committing 10 creates each at once: 200 seqs, each once, every path unique', async () => {
    const { vaultId } = await t.vault(account)
    const devices: SimDevice[] = []
    for (let i = 0; i < 20; i++) devices.push(await sim(vaultId, `device-${i}`))
    for (const [i, d] of devices.entries()) {
      for (let j = 0; j < 10; j++) d.write(`d${i}/note-${j}.md`, `device ${i}, note ${j}\n`)
    }

    const responses = await Promise.all(devices.map((d) => d.sync()))
    for (const r of responses) {
      expect(r?.results.map((x) => x.status)).toEqual(Array(10).fill('applied'))
    }
    expect(devices.map((d) => d.stats.commits)).toEqual(Array(20).fill(1))

    const observer = api(t.app, (await t.device(account, vaultId, 'observer')).deviceToken)
    const state = (await observer.get(`/v1/vaults/${vaultId}/state`)).body as VaultState
    expect(state.head_seq).toBe(200)
    const feed = (await observer.get(`/v1/vaults/${vaultId}/changes?since=0&limit=1000`))
      .body as ChangesResponse
    expect(feed.items.map((x) => x.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
    expect(feed.head_seq).toBe(200)
    const manifest = (await observer.get(`/v1/vaults/${vaultId}/manifest?limit=1000`))
      .body as ManifestResponse
    expect(new Set(manifest.items.map((x) => x.path)).size).toBe(200)
    expect(manifest.next).toBeNull()

    await converge(...devices)
    expect(devices[0]?.disk.size).toBe(200)
  })

  it('two devices modifying one note at once with the same base: one applied, one merged, both edits kept', async () => {
    const { vaultId } = await t.vault(account)
    const a = await sim(vaultId, 'a')
    const b = await sim(vaultId, 'b')
    a.write('Note.md', 'one\ntwo\nthree\n')
    await a.sync()
    await b.sync()
    expect(a.state.get('Note.md')?.versionId).toBe(b.state.get('Note.md')?.versionId)

    a.write('Note.md', 'ONE\ntwo\nthree\n')
    b.write('Note.md', 'one\ntwo\nTHREE\n')
    const [ra, rb] = await Promise.all([a.sync(), b.sync()])
    const statuses = [ra?.results[0]?.status, rb?.results[0]?.status].sort()
    expect(statuses).toEqual(['applied', 'merged'])

    await converge(a, b)
    expect(a.text('Note.md')).toBe('ONE\ntwo\nTHREE\n')
    expect(b.text('Note.md')).toBe('ONE\ntwo\nTHREE\n')
  })
})
