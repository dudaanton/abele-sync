import { expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob } from '../helpers/ops.js'

it('refuses a false content size both for an upload and reuse of a vault version', async () => {
  const t = await buildTestApp()
  try {
    const { accountToken } = await t.account(),
      { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const bytes = 'actual bytes, not zero'
    await putBlob(t.app, deviceToken, bytes)
    const send = async (path: string, size: number) =>
      (await commit(t.app, deviceToken, vaultId, [{ ...create(path, bytes), size }])).results[0]
    expect(await send('a.md', 0)).toMatchObject({ status: 'rejected', code: 'invalid_request' })
    expect(await send('a.md', bytes.length)).toMatchObject({ status: 'applied' })
    expect(await send('copy.md', 0)).toMatchObject({ status: 'rejected', code: 'invalid_request' })
    expect(await t.db.selectFrom('versions').select('size').execute()).toEqual([
      { size: bytes.length },
    ])
  } finally {
    await t.close()
  }
})
