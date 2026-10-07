import { afterAll, beforeAll, expect, it } from 'vitest'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

let t: TestApp
beforeAll(async () => {
  t = await buildTestApp()
})
afterAll(async () => {
  await t.close()
})

it('a digest from another vault cannot be claimed, and answers like an absent blob', async () => {
  const enrol = async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    return { vaultId, deviceToken }
  }
  const a = await enrol(),
    b = await enrol()
  const secret = 'private bytes belonging only to A'
  await putBlob(t.app, a.deviceToken, secret)
  await commit(t.app, a.deviceToken, a.vaultId, [create('Secret.md', secret)])
  const attempt = async (text: string) =>
    (await commit(t.app, b.deviceToken, b.vaultId, [create('Stolen.md', text)])).results[0]
  const stolen = await attempt(secret)
  const absent = await attempt('not stored anywhere')
  expect(stolen).toEqual({
    ...absent,
    message: absent.message.replace(shaOf('not stored anywhere'), shaOf(secret)),
  })
  expect(stolen).toMatchObject({ status: 'rejected', code: 'not_found' })
  expect(
    (await api(t.app, b.deviceToken).raw({ method: 'GET', url: `/v1/blobs/${shaOf(secret)}` }))
      .status
  ).toBe(404)
  // Knowing the actual bytes is sufficient, and a second create may reuse a vault's version.
  await putBlob(t.app, b.deviceToken, secret)
  expect(await attempt(secret)).toMatchObject({ status: 'applied' })
  expect(
    (await commit(t.app, b.deviceToken, b.vaultId, [create('Copy.md', secret)])).results[0]
  ).toMatchObject({ status: 'applied' })
})
