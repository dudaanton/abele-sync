import { expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob } from '../helpers/ops.js'

it('rejects a file at a live folder path and a child under a live file', async () => {
  const t = await buildTestApp()
  try {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    await putBlob(t.app, deviceToken, 'one')
    const send = async (path: string) =>
      (await commit(t.app, deviceToken, vaultId, [create(path, 'one')])).results[0]
    expect(await send('Notes/a.md')).toMatchObject({ status: 'applied' })
    expect(await send('Notes')).toMatchObject({ status: 'rejected', code: 'path_taken' })
    expect(await send('Notes/a.md/child.md')).toMatchObject({
      status: 'rejected',
      code: 'path_taken',
    })
    expect(await send('Other')).toMatchObject({ status: 'applied' })
    expect(await send('Other/child.md')).toMatchObject({ status: 'rejected', code: 'path_taken' })
    const source = await send('Source.md')
    const moved = await commit(t.app, deviceToken, vaultId, [
      {
        op: 'move',
        file_id: source.file_id,
        base_version_id: source.version_id,
        to_path: 'Notes',
      },
    ])
    expect(moved.results[0]).toMatchObject({ status: 'rejected', code: 'path_taken' })
    expect((await t.db.selectFrom('files').select('path').execute()).map((f) => f.path)).toEqual([
      'Notes/a.md',
      'Other',
      'Source.md',
    ])
  } finally {
    await t.close()
  }
})
