import { expect } from 'vitest'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import type { V2CommitOp, CommitOpResult, V2ManifestItem } from '@abele/sync-protocol'
import type { AcceptanceFixture } from './fixture.js'

/** These are server facets, not claims about client coordination or live placement/UI. */
export const stage2ServerFacets = new Set([
  5,
  6,
  12,
  13,
  15,
  22,
  23,
  ...Array.from({ length: 17 }, (_, i) => i + 24),
  108,
  109,
  110,
  ...Array.from({ length: 15 }, (_, i) => i + 42),
  69,
  70,
  71,
  72,
  73,
])
const applied = (result: CommitOpResult) => {
  if (result.status === 'rejected') throw new Error(result.message)
  return result
}
export async function stage2ServerFacet(number: number, f: AcceptanceFixture) {
  const owner = new V2SyncClient(f.roots[0]!.token)
  const second = new V2SyncClient(f.roots[1]!.token)
  const dir = applied((await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!)
  const share = await owner.share(dir.file_id)
  const guest = new V2SyncClient(share.token)
  const peer = new V2SyncClient((await guest.share(dir.file_id)).token)
  const items = async (client = guest) => (await client.manifest()).items
  const find = async (path: string, client = guest) =>
    (await items(client)).find((i) => i.path === path)!
  const create = async (path = 'Shared/Note.md', bytes = 'original', client = owner) =>
    applied(await client.create(path, bytes))
  const move = async (
    file: V2ManifestItem | ReturnType<typeof applied>,
    path: string,
    client = owner
  ) =>
    applied(
      (
        await client.commit([
          { op: 'move', file_id: file.file_id, base_version_id: file.version_id, to_path: path },
        ])
      ).results[0]!
    )
  const remove = async (file: V2ManifestItem | ReturnType<typeof applied>, client = owner) =>
    applied(
      (
        await client.commit([
          { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
        ])
      ).results[0]!
    )
  const modify = async (
    file: V2ManifestItem | ReturnType<typeof applied>,
    bytes: string,
    client = guest
  ) =>
    applied(
      (
        await client.commit([
          {
            op: 'modify',
            file_id: file.file_id,
            base_version_id: file.version_id,
            ...(await client.upload(Buffer.from(bytes))),
            mtime: 2000,
          },
        ])
      ).results[0]!
    )
  switch (number) {
    case 29:
    case 108:
    case 110: {
      const base = await create('Shared/Note.md', 'one\ntwo\n')
      await modify(base, 'ONE\ntwo\n', owner)
      const incoming = await peer.upload(Buffer.from('one\nTWO\n'))
      const merged = applied(
        (
          await peer.commit([
            {
              op: 'modify',
              file_id: base.file_id,
              base_version_id: base.version_id,
              ...incoming,
              mtime: 3000,
            },
          ])
        ).results[0]!
      )
      expect((await owner.content(base.file_id)).toString()).toBe('ONE\nTWO\n')
      expect(merged.mtime).toBe(3000)
      return
    }
    case 39: {
      const head = await create('Shared/Note.md', 'server variant\n')
      const conflict = applied(await guest.create('Shared/Note.md', 'local variant\n'))
      expect(conflict.status).toBe('conflict')
      if (conflict.status !== 'conflict') throw new Error('expected conflict')
      expect((await guest.content(head.file_id)).toString()).toBe('server variant\n')
      expect((await guest.content(conflict.conflict_file_id!)).toString()).toBe('local variant\n')
      const replay = applied(await peer.create('Shared/Note.md', 'local variant\n'))
      if (replay.status !== 'conflict') throw new Error('expected replayed conflict')
      expect(replay.conflict_file_id).toBe(conflict.conflict_file_id)
      expect((await items()).filter((i) => i.kind !== 'directory')).toHaveLength(2)
      return
    }
    case 109: {
      const base = await create()
      await remove(base, owner)
      const revived = await modify(base, 'offline edit\n', guest)
      expect(revived.file_id).toBe(base.file_id)
      expect((await peer.content(base.file_id)).toString()).toBe('offline edit\n')
      return
    }
    case 5:
    case 6:
    case 13:
    case 24:
    case 25:
    case 26:
    case 35:
    case 36:
    case 37:
    case 42: {
      await create('Shared/Note.md', '[[Sub/Linked]]')
      await create('Shared/Sub/Linked.md', 'linked')
      const privateFile = await create('Private.md', 'not shared')
      expect((await items()).map((i) => i.path).sort()).toEqual([
        'Shared',
        'Shared/Note.md',
        'Shared/Sub',
        'Shared/Sub/Linked.md',
      ])
      expect((await items(owner)).map((i) => i.path)).toContain('Private.md')
      await expect(guest.content(privateFile.file_id)).rejects.toMatchObject({ status: 404 })
      expect((await guest.create('Outside.md', 'denied')).status).toBe('rejected')
      await second.create('Elsewhere.md', 'second space')
      expect((await second.manifest()).items.map((i) => i.path)).toEqual(['Elsewhere.md'])
      expect((await items()).map((i) => i.path)).not.toContain('Elsewhere.md')
      expect((await peer.content((await find('Shared/Note.md')).file_id)).toString()).toBe(
        '[[Sub/Linked]]'
      )
      return
    }
    case 12:
    case 15:
    case 27:
    case 28:
    case 31:
    case 33:
    case 38:
    case 43:
    case 44: {
      const file = await create()
      const bytes = '---\ncustom: kept\n---\nedit\n'
      const changed = await modify(file, bytes)
      expect((await owner.content(file.file_id)).toString()).toBe(bytes)
      expect((await peer.content(file.file_id)).toString()).toBe(bytes)
      const forwarded = applied(
        await second.create('Shared/Note.md', await guest.content(file.file_id))
      )
      expect((await second.content(forwarded.file_id)).toString()).toBe(bytes)
      const cursor = (await owner.manifest()).cursor
      for (let idle = 0; idle < 3; idle++) {
        expect(applied(await peer.create('Shared/Note.md', bytes)).file_id).toBe(file.file_id)
        expect((await second.create('Shared/Note.md', bytes)).status).toBe('applied')
        expect((await owner.manifest()).cursor).toBe(cursor)
      }
      expect((await find('Shared/Note.md')).version_id).toBe(changed.version_id)
      expect((await items()).filter((i) => i.kind !== 'directory')).toHaveLength(1)
      return
    }
    case 30: {
      const file = await create()
      const network = f.devices[0]!.network
      const slow = new V2SyncClient(f.roots[1]!.token, network.fetch)
      const barrier = network.delayNextResponse(
        (url, method) => url === slow.address + '/v2/commit' && method === 'POST'
      )
      let answered = false
      const pending = slow.create('Shared/Note.md', 'pending slow bytes').then((result) => {
        answered = true
        return applied(result)
      })
      try {
        await barrier.entered
        await modify(file, 'pending slow bytes', guest)
        expect((await owner.content(file.file_id)).toString()).toBe('pending slow bytes')
        expect(answered).toBe(false)
      } finally {
        barrier.release()
      }
      const result = await pending
      expect((await second.content(result.file_id)).toString()).toBe('pending slow bytes')
      return
    }
    case 22:
    case 23:
    case 34: {
      const file = await create()
      const before = await guest.content(file.file_id)
      await owner.json('/tokens/' + share.info.id, 'DELETE')
      await expect(guest.manifest()).rejects.toMatchObject({ status: 401 })
      const attempt: V2CommitOp = {
        op: 'delete',
        file_id: file.file_id,
        base_version_id: file.version_id,
      }
      await expect(guest.commit([attempt])).rejects.toMatchObject({ status: 401 })
      // Descendants and overlapping tokens continue; revocation does not create file events.
      const cursor = (await peer.manifest()).cursor
      expect((await peer.changes(cursor)).items).toEqual([])
      expect(await peer.content(file.file_id)).toEqual(before)
      await modify(file, 'peer still writes', peer)
      expect((await owner.content(file.file_id)).toString()).toBe('peer still writes')
      return
    }
    case 32: {
      await owner.commit([{ op: 'mkdir', path: 'Shared/Nested' }])
      const nested = await find('Shared/Nested')
      const narrow = new V2SyncClient((await guest.share(nested.file_id)).token)
      const file = await create('Shared/Nested/Note.md', 'original', narrow)
      await modify(file, 'overlap is writable', peer)
      expect((await narrow.content(file.file_id)).toString()).toBe('overlap is writable')
      expect((await narrow.create('Shared/Outside.md', 'no')).status).toBe('rejected')
      return
    }
    case 40: {
      const file = await create()
      expect(
        (await guest.commit([{ op: 'mkdir', path: 'Shared/Note.md/Child' }])).results[0]!.status
      ).toBe('rejected')
      await owner.commit([{ op: 'mkdir', path: 'Shared/Empty' }])
      expect((await guest.create('Shared/Empty', 'obstacle')).status).toBe('rejected')
      expect((await guest.commit([{ op: 'mkdir', path: 'shared/case' }])).results[0]!.status).toBe(
        'rejected'
      )
      expect((await guest.content(file.file_id)).toString()).toBe('original')
      return
    }
    case 45:
    case 46:
    case 47:
    case 48:
    case 49:
    case 50:
    case 51:
    case 52:
    case 71:
    case 72:
    case 73: {
      const opaque = number >= 71
      let file = await create(
        number === 47 ? 'Private.md' : opaque ? 'Shared/Asset.canvas' : 'Shared/Note.md',
        opaque ? '{"nodes":[]}' : 'current bytes'
      )
      const start = (await guest.manifest()).cursor
      if (number === 51 || number === 52 || number === 73) {
        const remote = applied(await second.create(file.path, await guest.content(file.file_id)))
        await remove(file, peer)
        expect((await guest.changes(start)).items).toContainEqual(
          expect.objectContaining({ type: 'delete', file_id: file.file_id })
        )
        if (number === 52) {
          await remove(remote, second)
          expect(
            (await second.manifest()).items.filter((i) => i.kind !== 'directory')
          ).toHaveLength(0)
        }
      } else if ([48, 49, 50, 72].includes(number)) {
        file = await move(file, 'Private/Outside' + (opaque ? '.canvas' : '.md'))
        const feed = await guest.changes(start)
        expect(feed.items).toContainEqual(
          expect.objectContaining({ type: 'removal', file_id: file.file_id })
        )
        expect(JSON.stringify(feed)).not.toContain('Private/Outside')
        expect((await owner.content(file.file_id)).toString()).toBe(
          opaque ? '{"nodes":[]}' : 'current bytes'
        )
        if (number === 49) {
          file = await modify(file, 'returned current bytes', owner)
          await move(file, 'Shared/Back.md')
          expect((await guest.content(file.file_id)).toString()).toBe('returned current bytes')
        }
        if (number === 50) {
          const remote = applied(
            await second.create('Destination/Note.md', await owner.content(file.file_id))
          )
          expect((await second.content(remote.file_id)).toString()).toBe('current bytes')
        }
      } else {
        file = await move(
          file,
          number === 47 ? 'Shared/Entered.md' : 'Shared/Sub/Renamed' + (opaque ? '.canvas' : '.md'),
          number === 47 ? owner : peer
        )
        expect((await guest.content(file.file_id)).toString()).toBe(
          opaque ? '{"nodes":[]}' : 'current bytes'
        )
        expect((await items()).filter((i) => i.kind !== 'directory').map((i) => i.path)).toEqual([
          file.path,
        ])
      }
      return
    }
    case 53:
    case 54:
    case 55:
    case 56: {
      await owner.commit([{ op: 'mkdir', path: 'Shared/Sub/Empty' }])
      const file = await create('Shared/Sub/Note.md')
      const neighbor = await create('Neighbor.md', 'unaffected')
      if (number === 53) {
        expect((await items()).map((i) => i.path).sort()).toEqual([
          'Shared',
          'Shared/Sub',
          'Shared/Sub/Empty',
          'Shared/Sub/Note.md',
        ])
        return
      }
      const source = number === 55 ? await find('Shared/Sub') : await find('Shared')
      const start = (await guest.manifest()).cursor
      if (number === 56) {
        await owner.commit([
          { op: 'delete_directory', file_id: source.file_id, base_version_id: source.version_id },
        ])
        expect((await guest.changes(start)).items.filter((i) => i.type === 'delete')).toHaveLength(
          4
        )
        expect((await guest.json('/connection')).status).toBe('scope_unavailable')
        await expect(guest.manifest()).rejects.toMatchObject({ status: 503 })
      } else {
        await owner.commit([
          {
            op: 'move_directory',
            file_id: source.file_id,
            base_version_id: source.version_id,
            to_path: number === 54 ? 'Renamed' : 'Outside',
          },
        ])
        if (number === 54) {
          expect((await guest.json('/connection')).scope.path).toBe('Renamed')
          expect((await items()).map((i) => i.path)).toContain('Renamed/Sub/Empty')
          expect((await guest.content(file.file_id)).toString()).toBe('original')
        } else {
          expect(
            (await guest.changes(start)).items.filter((i) => i.type === 'removal')
          ).toHaveLength(3)
          expect((await owner.content(file.file_id)).toString()).toBe('original')
        }
      }
      expect((await owner.content(neighbor.file_id)).toString()).toBe('unaffected')
      return
    }
    case 69:
    case 70: {
      const file = applied(await owner.create('Shared/Binary.bin', Buffer.from([0, 255, 1])))
      expect(await guest.content(file.file_id)).toEqual(Buffer.from([0, 255, 1]))
      if (number === 70) {
        await modify(file, 'changed by nonauthor', peer)
        expect((await owner.content(file.file_id)).toString()).toBe('changed by nonauthor')
      }
      return
    }
    default:
      throw new Error('No stage-2 server facet: ' + number)
  }
}
