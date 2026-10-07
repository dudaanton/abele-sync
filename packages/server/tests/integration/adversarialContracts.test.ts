import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validatePath } from '@abele/sync-protocol'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
import { commit, create, octet, putBlob, shaOf } from '../helpers/ops.js'

let t: TestApp, token: string, vault: string
beforeEach(async () => {
  t = await buildTestApp()
  const { accountToken } = await t.account()
  vault = (await t.vault(accountToken)).vaultId
  token = (await t.device(accountToken, vault, 'adversarial')).deviceToken
})
afterEach(async () => {
  await t.close()
})
const post = (ops: unknown[]) => commit(t.app, token, vault, ops)

describe('Adversarial: wire contracts', () => {
  // BUG: B20 — intact() opens an inverted ReadStream interval for an empty blob.
  it('B20 repeated empty PUT is still 201', async () => {
    await putBlob(t.app, token, '')
    const retry = await api(t.app, token).raw({
      method: 'PUT',
      url: `/v1/blobs/${shaOf('')}`,
      payload: Buffer.alloc(0),
      headers: octet,
    })
    expect(retry.status).toBe(201)
  })

  for (const order of [
    ['box', 'box/note.md'],
    ['box/note.md', 'box'],
  ]) {
    // BUG: B10 — exact path uniqueness does not enforce the tree namespace.
    it(`B10 rejects ancestor/descendant collision ${order.join(' then ')}`, async () => {
      await putBlob(t.app, token, 'x')
      const first = await post([create(order[0]!, 'x')])
      expect(first.results[0].status).toBe('applied')
      const second = await post([create(order[1]!, 'x')])
      expect(second.results[0].status).toBe('rejected')
    })
  }

  for (const stem of ['a'.repeat(252), 'я'.repeat(126)]) {
    // BUG: B11 — generated conflict names do not revalidate the UTF-8 segment limit.
    it(`B11 conflict copy remains valid at ${Buffer.byteLength(stem)} byte ${stem[0]} stem`, async () => {
      const path = `${stem}.md`
      expect(() => validatePath(path)).not.toThrow()
      expect(
        (
          await api(t.app, token).patch(`/v1/vaults/${vault}/settings`, {
            conflict: 'conflict-file',
          })
        ).status
      ).toBe(200)
      await putBlob(t.app, token, 'first\n')
      await putBlob(t.app, token, 'second\n')
      await post([create(path, 'first\n')])
      const answer = await post([create(path, 'second\n')])
      expect(answer.results[0].status).toBe('conflict')
      expect(() => validatePath(answer.results[0].conflict_path)).not.toThrow()
    })
  }

  for (const path of ['/absolute.md', 'folder\\note.md']) {
    // BUG: B24a — spec §3.8 rejects absolute/backslash paths; code normalizes them.
    it(`B24a rejects non-wire path ${JSON.stringify(path)}`, async () => {
      await putBlob(t.app, token, 'x')
      expect((await post([create(path, 'x')])).results[0].status).toBe('rejected')
    })
  }

  // §3.4 defines per-op results; §12.2 describes whole-batch quota refusal instead.
  // Assert the existing per-op behavior until the product contract resolves the contradiction.
  it('B9 quota overflow rejects only the operation exceeding the limit', async () => {
    await putBlob(t.app, token, 'a'.repeat(60))
    await putBlob(t.app, token, 'b'.repeat(60))
    expect(
      (
        await api(t.app, token).patch(`/v1/vaults/${vault}/settings`, {
          quota_bytes: 100,
          account_password: TEST_PASSWORD,
        })
      ).status
    ).toBe(200)
    const answer = await post([create('a.bin', 'a'.repeat(60)), create('b.bin', 'b'.repeat(60))])
    expect(answer.results.map((r: { status: string }) => r.status)).toEqual(['applied', 'rejected'])
    expect(
      (await api(t.app, token).get(`/v1/vaults/${vault}/manifest`)).body.items.map(
        (item: { path: string }) => item.path
      )
    ).toEqual(['a.bin'])
  })
})
