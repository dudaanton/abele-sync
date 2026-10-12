import { expect } from 'vitest'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { V2EngineClient } from '../../src/v2Client.js'
import type { CommitOpResult } from '@abele/sync-protocol'
import type { AcceptanceFixture } from './fixture.js'

/** Server/core facets only. Opening a note and consent UI still require live evidence. */
export const groupServerFacets = new Set([
  14,
  41,
  ...Array.from({ length: 12 }, (_, i) => i + 57),
  ...Array.from({ length: 9 }, (_, i) => i + 74),
])
const ok = (result: CommitOpResult) => {
  if (result.status === 'rejected') throw new Error(result.message)
  return result
}
const note = (groups: string[], body = 'member\n') =>
  `---\ngroups: [${groups.map((g) => JSON.stringify(`[[${g}]]`)).join(', ')}]\ncustom: retained\n---\n${body}`
export async function groupServerFacet(number: number, f: AcceptanceFixture) {
  const owner = new V2SyncClient(f.roots[0]!.token)
  const root = ok(await owner.create('Groups/Root.md', 'root\n'))
  const issue = await owner.json('/tokens', 'POST', {
    scope: { kind: 'group', id: root.file_id },
    label: 'Group',
  })
  const guest = new V2SyncClient(issue.token)
  const peer = new V2SyncClient(
    (
      await guest.json('/tokens', 'POST', {
        scope: { kind: 'group', id: root.file_id },
        label: 'Peer',
      })
    ).token
  )
  const create = async (path: string, groups = ['Groups/Root'], body?: string, client = owner) =>
    ok(await client.create(path, note(groups, body)))
  const modify = async (file: ReturnType<typeof ok>, bytes: string, client = guest) =>
    ok(
      (
        await client.commit([
          {
            op: 'modify',
            file_id: file.file_id,
            base_version_id: file.version_id,
            ...(await client.upload(Buffer.from(bytes))),
            mtime: file.mtime + 1000,
          },
        ])
      ).results[0]!
    )
  const member = await create('Notes/Member.md')
  if (number === 58) {
    const device = f.devices[0]!
    for (const id of [...device.connections.keys()]) await device.disconnect(id)
    await device.write('Local/Nested.md', note(['Groups/Root']))
    await device.write('Local/Child.md', note(['Local/Nested']))
    await device.write('Local/Private.md', 'private neighbor')
    await device.paste(issue.token, 'group')
    for (let i = 0; i < 5; i++) await device.sync('group')
    expect((await peer.manifest()).items.map((i) => i.path)).toContain('Local/Child.md')
    expect((await owner.manifest()).items.map((i) => i.path)).not.toContain('Local/Private.md')
    expect(await device.text('Local/Private.md')).toBe('private neighbor')
    return
  }
  if (number === 41 || number === 62 || number === 63) {
    const second = new V2SyncClient(f.roots[1]!.token)
    const otherRoot = ok(await second.create('Other/Group.md', 'other group'))
    const otherIssue = await second.json('/tokens', 'POST', {
      scope: { kind: 'group', id: otherRoot.file_id },
      label: 'Other group',
    })
    const other = new V2SyncClient(otherIssue.token)
    const bytes = note(['Groups/Root', 'Other/Group', 'Foreign/Unknown'], 'one\ntwo\n')
    let shared = await modify(member, bytes)
    let forwarded = ok(await other.create('Notes/Member.md', await guest.content(member.file_id)))
    expect((await other.content(forwarded.file_id)).toString()).toBe(bytes)
    shared = await modify(
      shared,
      note(['Groups/Root', 'Other/Group', 'Foreign/Unknown'], 'ONE\ntwo\n')
    )
    forwarded = await modify(forwarded, (await guest.content(shared.file_id)).toString(), other)
    expect((await peer.content(shared.file_id)).toString()).toEqual(
      (await other.content(forwarded.file_id)).toString()
    )
    const counts = await Promise.all(
      f.servers.map((s) => s.db.selectFrom('versions').select('id').execute())
    )
    for (let i = 0; i < 3; i++) {
      expect(
        ok(await other.create('Notes/Member.md', await guest.content(shared.file_id))).file_id
      ).toBe(forwarded.file_id)
      expect(
        ok(await guest.create('Notes/Member.md', await other.content(forwarded.file_id))).file_id
      ).toBe(shared.file_id)
    }
    expect(
      await Promise.all(f.servers.map((s) => s.db.selectFrom('versions').select('id').execute()))
    ).toEqual(counts)
    return
  }
  if (number === 59 || number === 60 || number === 61) {
    const otherRoot = ok(await owner.create('Other/Group.md', 'private group'))
    const other = new V2SyncClient(
      (
        await owner.json('/tokens', 'POST', {
          scope: { kind: 'group', id: otherRoot.file_id },
          label: 'Other',
        })
      ).token
    )
    const bytes = note(['Groups/Root', 'Other/Group', 'Foreign/Unknown'])
    const both = await modify(member, bytes)
    expect((await other.content(both.file_id)).toString()).toBe(bytes)
    await expect(guest.content(otherRoot.file_id)).rejects.toMatchObject({ status: 404 })
    const edited = await modify(
      both,
      note(['Groups/Root', 'Other/Group', 'Foreign/Unknown'], 'edited\n')
    )
    expect((await other.content(edited.file_id)).toString()).toContain('edited')
    return
  }
  if (number === 64 || number === 65) {
    const cursor = (await guest.manifest()).cursor
    const left = await modify(member, note(['Foreign/Unknown'], 'left\n'))
    expect((await guest.changes(cursor)).items).toEqual([
      expect.objectContaining({ type: 'removal', path: 'Notes/Member.md' }),
    ])
    await expect(peer.content(member.file_id)).rejects.toMatchObject({ status: 404 })
    await expect(peer.json(`/files/${member.file_id}/history`)).rejects.toMatchObject({
      status: 404,
    })
    if (number === 65) {
      const returned = await modify(left, note(['Groups/Root'], 'returned\n'), owner)
      expect((await peer.content(returned.file_id)).toString()).toContain('returned')
    }
    return
  }
  if (number === 66) {
    const renamed = ok(
      (
        await owner.commit([
          {
            op: 'move',
            file_id: root.file_id,
            base_version_id: root.version_id,
            to_path: 'Groups/Renamed.md',
          },
        ])
      ).results[0]!
    )
    expect((await guest.json('/connection')).scope.path).toBe(renamed.path)
    expect((await peer.content(member.file_id)).toString()).toBe(note(['Groups/Root']))
    await f.servers[0]!.restart()
    expect((await peer.manifest()).items.map((i) => i.path).sort()).toEqual([
      'Groups/Renamed.md',
      'Notes/Member.md',
    ])
    return
  }
  if (number === 67 || number === 68) {
    const device = f.devices[0]!
    for (const id of [...device.connections.keys()]) await device.disconnect(id)
    await device.paste(issue.token, 'group')
    await device.sync('group')
    const before = await device.text('Notes/Member.md')
    await owner.commit([{ op: 'delete', file_id: root.file_id, base_version_id: root.version_id }])
    expect((await guest.json('/connection')).status).toBe('scope_unavailable')
    await expect(device.sync('group')).rejects.toMatchObject({ code: 'scope_unavailable' })
    expect(await device.text('Notes/Member.md')).toBe(before)
    if (number === 68) {
      await owner.create('Groups/Root.md', 'replacement')
      expect((await peer.json('/connection')).status).toBe('scope_unavailable')
    }
    return
  }
  if (number === 14 || number === 57) {
    const child = await create('Groups/Child.md')
    const nested = await create('Other/Nested.md', ['Groups/Child'])
    expect((await peer.manifest()).items.map((i) => i.path).sort()).toEqual([
      'Groups/Child.md',
      'Groups/Root.md',
      'Notes/Member.md',
      'Other/Nested.md',
    ])
    expect((await peer.content(nested.file_id)).toString()).toBe(note(['Groups/Child']))
    expect(child.file_id).not.toBe(root.file_id)
    return
  }
  // Attachment facets 74–82: private links and local possession never grant publication.
  const privateFile = ok(await owner.create('Private.png', Buffer.from([1, 2, 3])))
  await modify(member, note(['Groups/Root'], '![[Private.png]]\n'))
  await expect(guest.content(privateFile.file_id)).rejects.toMatchObject({ status: 404 })
  await expect(
    guest.json('/group-assets', 'POST', { file_id: privateFile.file_id })
  ).rejects.toMatchObject({ status: 404 })
  expect((await guest.manifest()).items.map((i) => i.path)).not.toContain('Private.png')
  if (number === 74 || number === 78 || number === 82) {
    const client = new V2EngineClient(issue.token, { fetch })
    const path = number === 82 ? 'Canvas.canvas' : 'Public.png'
    const bytes =
      number === 82
        ? new TextEncoder().encode('{"nodes":[{"file":"Private.png"}]}')
        : new Uint8Array([4, 5, 6])
    const publication = await client.publishGroupAsset(path, bytes, 1000, 'explicit-consent')
    const published = ok(publication.results[0]!)
    expect(await peer.content(published.file_id)).toEqual(Buffer.from(bytes))
    expect(await client.publishGroupAsset(path, bytes, 1000, 'explicit-consent')).toEqual(
      publication
    )
    expect((await peer.manifest()).items.map((i) => i.path)).not.toContain('Private.png')
  }
  if (number === 76 || number === 77 || number === 79 || number === 80 || number === 81) {
    const device = f.devices[0]!
    for (const id of [...device.connections.keys()]) await device.disconnect(id)
    await device.write('Private.png', 'private local bytes')
    await device.paste(issue.token, 'group')
    for (let i = 0; i < 3; i++) await device.sync('group')
    expect(await device.text('Private.png')).toBe('private local bytes')
    expect(
      device.network.requests.some((r) => new URL(r.url).pathname === '/v2/group-assets')
    ).toBe(false)
    expect(await owner.content(privateFile.file_id)).toEqual(Buffer.from([1, 2, 3]))
  }
}
