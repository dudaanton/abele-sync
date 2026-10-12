import { expect, it } from 'vitest'
import { AccessClient } from '../../src/index.js'
import { acceptanceFixture } from './fixture.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'

it('037/048/049 scope departure removes the shared copy without learning the private destination or republishing it', async () => {
  const f = await acceptanceFixture()
  try {
    const owner = new V2SyncClient(f.roots[0]!.token)
    const directory = (await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!
    if (directory.status === 'rejected') throw new Error(directory.message)
    const share = await owner.share(directory.file_id)
    const b = f.devices[1]!
    await b.disconnect('server-1')
    await b.disconnect('server-2')
    await b.paste(share.token, 'shared')
    const file = await owner.create('Shared/N.md', 'shared bytes\n')
    if (file.status === 'rejected') throw new Error(file.message)
    await b.sync('shared')
    expect(await b.text('Shared/N.md')).toBe('shared bytes\n')
    await owner.commit([
      {
        op: 'move',
        file_id: file.file_id,
        base_version_id: file.version_id,
        to_path: 'Private/N.md',
      },
    ])
    await b.sync('shared')
    expect(await b.fs.stat('Shared/N.md')).toBeNull()
    expect(await b.fs.stat('Private/N.md')).toBeNull()
    const cursor = (await owner.manifest()).cursor
    for (let idle = 0; idle < 3; idle++) await b.sync('shared')
    expect((await owner.manifest()).cursor).toBe(cursor)
    expect((await owner.content(file.file_id)).toString()).toBe('shared bytes\n')
    await owner.commit([
      {
        op: 'move',
        file_id: file.file_id,
        base_version_id: (await owner.manifest()).items.find((i) => i.file_id === file.file_id)!
          .version_id,
        to_path: 'Shared/N.md',
      },
    ])
    await b.sync('shared')
    expect(await b.text('Shared/N.md')).toBe('shared bytes\n')
    const access = AccessClient.fromToken(f.roots[0]!.token, { fetch })
    await access.revoke(share.info.id)
    await expect(b.sync('shared')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await b.text('Shared/N.md')).toBe('shared bytes\n')
  } finally {
    await f.close()
  }
})

it('103 directory and file commit journals survive a lost response and device/server restart', async () => {
  const f = await acceptanceFixture()
  try {
    const a = f.devices[0]!
    await a.fs.mkdir('Empty')
    a.network.dropNextResponse(
      (url, method) => url === f.servers[0]!.address + '/v2/commit' && method === 'POST'
    )
    await expect(a.sync('server-1')).rejects.toThrow()
    expect(await a.connection('server-1').binding.state.getMeta('v2-directories')).toContain(
      'pending'
    )
    await f.servers[0]!.restart()
    await a.restart()
    await a.sync('server-1')
    expect(await a.connection('server-1').binding.state.getMeta('v2-directories')).not.toContain(
      'pending'
    )
    await a.write('N.md', 'durable bytes\n')
    a.network.dropNextResponse(
      (url, method) => url === f.servers[0]!.address + '/v2/commit' && method === 'POST'
    )
    await expect(a.sync('server-1')).rejects.toThrow()
    expect(await a.connection('server-1').binding.state.getJournal()).not.toBeNull()
    await a.restart()
    await a.sync('server-1')
    expect(await a.connection('server-1').binding.state.getJournal()).toBeNull()
    const owner = new V2SyncClient(f.roots[0]!.token)
    const files = (await owner.manifest()).items
    expect(files.map((i) => i.path).sort()).toEqual(['Empty', 'N.md'])
    expect((await owner.content(files.find((i) => i.path === 'N.md')!.file_id)).toString()).toBe(
      'durable bytes\n'
    )
    const before = (await owner.manifest()).cursor
    await a.sync('server-1')
    expect((await owner.manifest()).cursor).toBe(before)
  } finally {
    await f.close()
  }
})
