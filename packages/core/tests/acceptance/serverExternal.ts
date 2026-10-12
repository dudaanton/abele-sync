import { expect } from 'vitest'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { NetworkControl, type AcceptanceFixture } from './fixture.js'
import type { ExternalVerifyRequest } from '@abele/sync-protocol'

/** Verification/download/forwarding server facets, not live hydration/eviction UI evidence. */
export const externalServerFacets = new Set([111, 112, 113, 114, 115, 116])
export async function externalServerFacet(number: number, f: AcceptanceFixture) {
  const owner = new V2SyncClient(f.roots[0]!.token)
  const target = new V2SyncClient(f.roots[1]!.token)
  const file = await owner.create('Assets/external.bin', Buffer.from([0, 1, 2, 255]))
  if (file.status === 'rejected') throw new Error(file.message)
  const connection = f.devices[0]!.connection('server-1')
  const network = new NetworkControl()
  const source = new V2EngineClient(connection.token, { fetch: network.fetch })
  const head = await source.head(file.file_id)
  const expected: ExternalVerifyRequest = {
    version_id: head.version_id,
    path: head.path,
    sha: head.sha,
    size: head.size,
  }
  expect(await source.verifyExternalFile(file.file_id, expected)).toEqual({
    verified: true,
    file_id: file.file_id,
    ...expected,
  })
  const content = () => source.versionBytes(file.file_id, head.version_id)
  if (number === 113) {
    network.disconnect(owner.address)
    await expect(content()).rejects.toMatchObject({ code: 'offline' })
    network.reconnect(owner.address)
    const id = (await connection.access.connection()).token_id
    await owner.json('/tokens/' + id, 'DELETE')
    await expect(content()).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await target.manifest()).items).toEqual([])
    return
  }
  if (number === 114) {
    const peer = new V2EngineClient(f.devices[1]!.connection('server-1').token, { fetch })
    await f.devices[1]!.connection('server-1').access.revoke(
      (await connection.access.connection()).token_id
    )
    await expect(content()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(await peer.verifyExternalFile(file.file_id, expected)).toMatchObject({ verified: true })
    expect(await peer.versionBytes(file.file_id, head.version_id)).toEqual(
      new Uint8Array([0, 1, 2, 255])
    )
    return
  }
  if (number === 116) {
    const changed = (
      await owner.commit([
        {
          op: 'modify',
          file_id: file.file_id,
          base_version_id: head.version_id,
          ...(await owner.upload(Buffer.from([9, 8, 7]))),
          mtime: 2000,
        },
      ])
    ).results[0]!
    if (changed.status === 'rejected') throw new Error(changed.message)
    await expect(source.verifyExternalFile(file.file_id, expected)).rejects.toMatchObject({
      code: 'not_found',
    })
    const current = await source.head(file.file_id)
    expect(
      await source.verifyExternalFile(file.file_id, {
        version_id: current.version_id,
        path: current.path,
        sha: current.sha,
        size: current.size,
      })
    ).toMatchObject({ verified: true })
    expect(await source.versionBytes(file.file_id, current.version_id)).toEqual(
      new Uint8Array([9, 8, 7])
    )
    return
  }
  const bytes = await content()
  expect(bytes).toEqual(new Uint8Array([0, 1, 2, 255]))
  if (number === 111) return
  if (number === 115) {
    const uploaded = await target.upload(Buffer.from(bytes))
    expect(await source.verifyExternalFile(file.file_id, expected)).toMatchObject({
      verified: true,
    })
    expect((await target.manifest()).items).toEqual([])
    expect(await f.servers[0]!.store.verify(expected.sha)).toEqual({
      sha: expected.sha,
      size: expected.size,
    })
    expect(
      await f.servers[1]!.db.selectFrom('blob_uploads')
        .selectAll()
        .where('sha', '=', uploaded.sha)
        .execute()
    ).toHaveLength(1)
    return
  }
  const forwarded = await target.create(head.path, Buffer.from(bytes), head.mtime)
  if (forwarded.status === 'rejected') throw new Error(forwarded.message)
  expect(await target.content(forwarded.file_id)).toEqual(Buffer.from(bytes))
  const targetClient = new V2EngineClient(f.roots[1]!.token, { fetch })
  expect(
    await targetClient.verifyExternalFile(forwarded.file_id, {
      version_id: forwarded.version_id,
      path: forwarded.path,
      sha: forwarded.sha!,
      size: forwarded.size,
    })
  ).toMatchObject({ verified: true })
}
