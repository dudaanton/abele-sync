import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adversarial, api, type Adversarial } from '../helpers/adversarial.js'
import { blob, create, seed } from '../helpers/seed.js'
import { Device, converge } from '../helpers/device.js'

let t: Adversarial
beforeEach(async () => {
  t = await adversarial()
})
afterEach(async () => {
  await t.close()
})

describe('Adversarial: account and blob boundaries', () => {
  for (const operation of ['create', 'modify'] as const) {
    // BUG: B2 — a global blob existence check grants a foreign vault a reference.
    it(`B2 ${operation}: knowing a foreign SHA must not grant read access`, async () => {
      const owner = await t.device('owner')
      const secret = 'synthetic private bytes, not shared with the other account'
      const size = Buffer.byteLength(secret, 'utf8')
      await owner.write('secret.md', secret)
      await owner.sync()
      const sha = (await owner.state.get('secret.md'))!.sha
      const other = await t.h.account()
      const v = await t.h.vault(other.accountToken)
      const { deviceToken } = await t.h.device(other.accountToken, v.vaultId)
      const c = t.h.clientFor(deviceToken, v.vaultId)
      const url = `/v1/blobs/${sha}`
      expect((await api(t.h.app, deviceToken).get(url)).status).toBe(404)
      let op
      if (operation === 'create') {
        op = { op: 'create' as const, path: 'stolen.md', sha, size, mtime: 1 }
      } else {
        const original = await seed(c, [await create(c, 'stolen.md', 'own content')])
        const r = original.results[0]!
        if (r.status === 'rejected') throw new Error('fixture rejected')
        op = {
          op: 'modify' as const,
          file_id: r.file_id,
          base_version_id: r.version_id,
          sha,
          size,
          mtime: 2,
        }
      }
      const answer = await c.commit([op], `adversarial-isolation-${operation}`)
      expect(answer.results[0]).toMatchObject({
        status: 'rejected',
        code: 'not_found',
        message: `blob ${sha} has not been uploaded`,
      })
      const after = await api(t.h.app, deviceToken).get(url)
      expect({ status: answer.results[0]!.status, get: after.status }).toEqual({
        status: 'rejected',
        get: 404,
      })
    })
  }

  for (const reported of [0, 1, 99]) {
    // BUG: B3 — commit trusts size instead of the uploaded blob's actual byte count.
    it(`B3 rejects a 100-byte blob declared as ${reported} bytes`, async () => {
      const d = await t.device('liar')
      const uploaded = await blob(d.client, 'x'.repeat(100))
      await t.settings(d.deviceToken, { max_file_bytes: reported === 99 ? 200 : 50 })
      const answer = await d.client.commit(
        [{ op: 'create', path: 'large.bin', ...uploaded, size: reported, mtime: 1 }],
        `adversarial-size-${reported}`
      )
      expect(answer.results[0]!.status).toBe('rejected')
      expect((await d.client.manifest(null)).items).toEqual([])
    })
  }

  it('three accounts, two vaults each: same path stays private; wrong-vault routes refuse', async () => {
    const pairs: Array<[Device, Device]> = []
    const accounts: string[] = []
    for (let a = 0; a < 3; a++) {
      const account = await t.h.account()
      accounts.push(account.accountId)
      for (let v = 0; v < 2; v++) {
        const { vaultId } = await t.h.vault(account.accountToken, `account-${a}-vault-${v}`)
        const make = async (name: string) =>
          new Device(
            t.h,
            vaultId,
            (await t.h.device(account.accountToken, vaultId, name)).deviceToken,
            name
          )
        const pair: [Device, Device] = [await make('writer'), await make('reader')]
        pairs.push(pair)
        await pair[0].write('same.md', `only account ${a} vault ${v}`)
        await converge(...pair)
        expect(await pair[1].text('same.md')).toBe(`only account ${a} vault ${v}`)
        expect(
          (await api(t.h.app, pair[0].deviceToken).get(`/v1/vaults/${t.vaultId}/manifest`)).status
        ).toBe(403)
      }
    }
    expect(new Set(await Promise.all(pairs.map(([, d]) => d.text('same.md')))).size).toBe(6)
    // Disabling one account cannot stop a different account's device.
    const victim = pairs[0]![0]
    await t.h.db
      .updateTable('accounts')
      .set({ disabled_at: new Date().toISOString() })
      .where('id', '=', accounts[0]!)
      .execute()
    await expect(victim.client.state()).rejects.toThrow()
    await pairs[2]![0].write('unaffected.md', 'other account still syncs')
    await converge(...pairs[2]!)
    expect(await pairs[2]![1].text('unaffected.md')).toBe('other account still syncs')
    for (const pair of pairs) for (const d of pair) await d.engine.stop()
  })
})
