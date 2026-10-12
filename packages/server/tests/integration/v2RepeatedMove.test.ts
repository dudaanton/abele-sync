import { expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'

it('a repeated descendant rename after a directory move is an authorized no-op, not a divergent move', async () => {
  const f = await tokenFixture()
  try {
    const file = success(await f.root.create('Agents/Sub/N.md', 'bytes\n'))
    const dir = (await f.root.manifest()).items.find((item) => item.path === 'Agents/Sub')!
    await f.root.commit([
      {
        op: 'move_directory',
        file_id: dir.file_id,
        base_version_id: dir.version_id,
        to_path: 'Agents/Renamed',
      },
    ])
    const before = (await f.root.manifest()).cursor
    const repeat = success(
      (
        await f.guest.commit([
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'Agents/Renamed/N.md',
          },
        ])
      ).results[0]!
    )
    expect(repeat).toMatchObject({ status: 'applied', path: 'Agents/Renamed/N.md' })
    expect((await f.root.manifest()).cursor).toBe(before)
    expect((await f.guest.content(file.file_id)).toString()).toBe('bytes\n')
  } finally {
    await f.close()
  }
})
