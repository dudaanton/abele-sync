import { afterEach, describe, expect, it } from 'vitest'
import { createUser } from '../../src/access/tokens.js'
import { v2Server, type V2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`v2 groups (${dialect})`, () => {
    let server: V2Server
    afterEach(async () => {
      await server?.close()
    })
    async function setup() {
      server = await v2Server(dialect)
      const root = await createUser(
        { db: server.db, pepper: server.config.tokenPepper, dialect },
        'Owner',
        server.address
      )
      const owner = new V2SyncClient(root.token)
      const group = await owner.create('Groups/Root.md', '# Root\n')
      if (group.status === 'rejected') throw new Error(group.message)
      const issue = await owner.json('/tokens', 'POST', {
        scope: { kind: 'group', id: group.file_id },
        label: 'Group',
      })
      return { owner, group, guest: new V2SyncClient(issue.token), issue }
    }
    it('indexes and authorizes a large note from bounded frontmatter without reading its whole blob', async () => {
      const { guest } = await setup()
      server.store.get = async () => {
        throw new Error('whole blob read forbidden')
      }
      const openRange = server.store.openRange.bind(server.store)
      server.store.openRange = async (sha, start = 0, end) => {
        expect(end).toBeDefined()
        expect(end! - start + 1).toBeLessThanOrEqual(1024 * 1024)
        return openRange(sha, start, end)
      }
      const result = await guest.create(
        'Large.md',
        '---\ngroups: ["[[Groups/Root]]"]\n---\n' + 'x'.repeat(1024 * 1024 + 7)
      )
      expect(result.status).toBe('applied')
      expect((await guest.manifest()).items.map((item) => item.path)).toContain('Large.md')
    })
    it('014/057/059–065 nested groups, cycles and foreign links are inert; departures do not expose private history', async () => {
      const { owner, guest, group } = await setup()
      const child = await owner.create(
        'Groups/Child.md',
        '---\ngroups: ["[[Groups/Root]]"]\n---\nchild\n'
      )
      if (child.status === 'rejected') throw new Error(child.message)
      const text =
        '---\ngroups: ["[[Groups/Child]]", "[[Foreign/Secret]]"]\ncustom: retained\n---\nbody [[Private]]\n'
      const member = await guest.create('Elsewhere/Member.md', text)
      expect(member.status).toBe('applied')
      if (member.status === 'rejected') throw new Error(member.message)
      await owner.create('Private.md', 'secret')
      expect((await guest.manifest()).items.map((i) => i.path).sort()).toEqual([
        'Elsewhere/Member.md',
        'Groups/Child.md',
        'Groups/Root.md',
      ])
      expect((await guest.content(member.file_id)).toString()).toBe(text)
      expect((await guest.create('Neighbor.md', 'no groups')).status).toBe('rejected')
      expect(
        (await guest.create('.obsidian/Bad.md', '---\ngroups: ["[[Groups/Root]]"]\n---\n')).status
      ).toBe('rejected')
      const second = await owner.create('Groups/Other.md', 'other')
      if (second.status === 'rejected') throw new Error(second.message)
      const otherToken = await owner.json('/tokens', 'POST', {
        scope: { kind: 'group', id: second.file_id },
        label: 'Other',
      })
      const other = new V2SyncClient(otherToken.token)
      const both =
        '---\ngroups: ["[[Groups/Root]]", "[[Groups/Other]]", "[[Foreign]]"]\n---\nboth\n'
      const changed = (
        await guest.commit([
          {
            op: 'modify',
            file_id: member.file_id,
            base_version_id: member.version_id,
            ...(await guest.upload(Buffer.from(both))),
            mtime: 2000,
          },
        ])
      ).results[0]!
      expect(changed.status).not.toBe('rejected')
      expect((await other.content(member.file_id)).toString()).toBe(both)
      if (changed.status === 'rejected') throw new Error(changed.message)
      const cursor = (await guest.manifest()).cursor
      const left = (
        await guest.commit([
          {
            op: 'modify',
            file_id: member.file_id,
            base_version_id: changed.version_id,
            ...(await guest.upload(Buffer.from('---\ngroups: ["[[Groups/Other]]"]\n---\nleft\n'))),
            mtime: 3000,
          },
        ])
      ).results[0]!
      expect(left.status).toBe('applied')
      expect((await guest.changes(cursor)).items).toContainEqual(
        expect.objectContaining({ type: 'removal', path: 'Elsewhere/Member.md' })
      )
      await expect(guest.json(`/files/${member.file_id}/history`)).rejects.toMatchObject({
        status: 404,
      })
      expect((await other.content(member.file_id)).toString()).toContain('left')
      if (left.status === 'rejected') throw new Error(left.message)
      await other.commit([
        {
          op: 'modify',
          file_id: member.file_id,
          base_version_id: left.version_id,
          ...(await other.upload(Buffer.from(both))),
          mtime: 4000,
        },
      ])
      expect((await guest.content(member.file_id)).toString()).toBe(both)
      await owner.commit([
        {
          op: 'modify',
          file_id: group.file_id,
          base_version_id: group.version_id,
          ...(await owner.upload(Buffer.from('---\ngroups: ["[[Groups/Child]]"]\n---\ncycle\n'))),
          mtime: 5000,
        },
      ])
      expect((await guest.manifest()).items).toHaveLength(3)
    })
    it('066–068 stable root follows rename and remains unavailable after replacement; descendants remain valid after issuer revocation', async () => {
      const { owner, guest, group, issue } = await setup()
      await owner.create('Member.md', '---\ngroups: ["[[Groups/Root]]"]\n---\nmember\n')
      const delegated = await guest.json('/tokens', 'POST', {
        scope: { kind: 'group', id: group.file_id },
        label: 'Delegated',
      })
      const child = new V2SyncClient(delegated.token)
      await expect(
        guest.json('/tokens', 'POST', {
          scope: { kind: 'folder', id: issue.info.scope.id },
          label: 'Escape',
        })
      ).rejects.toMatchObject({ status: 403 })
      const moved = (
        await owner.commit([
          {
            op: 'move',
            file_id: group.file_id,
            base_version_id: group.version_id,
            to_path: 'Renamed.md',
          },
        ])
      ).results[0]!
      if (moved.status === 'rejected') throw new Error(moved.message)
      expect((await guest.json('/connection')).scope.path).toBe('Renamed.md')
      expect((await guest.manifest()).items.map((i) => i.path).sort()).toEqual([
        'Member.md',
        'Renamed.md',
      ])
      await server.restart()
      expect((await child.manifest()).items).toHaveLength(2)
      await owner.json('/tokens/' + issue.info.id, 'DELETE')
      expect((await child.manifest()).items).toHaveLength(2)
      await owner.commit([
        { op: 'delete', file_id: moved.file_id, base_version_id: moved.version_id },
      ])
      expect((await child.json('/connection')).status).toBe('scope_unavailable')
      await expect(child.changes(0)).rejects.toMatchObject({ status: 503 })
      await owner.create('Renamed.md', 'replacement')
      expect((await child.json('/connection')).status).toBe('scope_unavailable')
    })
    it('074–082 private link/SHA/path is never publication; explicit upload publishes only the chosen asset and all participants may edit it', async () => {
      const { owner, guest } = await setup()
      const privateFile = await owner.create('Private.png', Buffer.from([1, 2, 3]))
      if (privateFile.status === 'rejected') throw new Error(privateFile.message)
      await guest.create('Member.md', '---\ngroups: ["[[Groups/Root]]"]\n---\n![[Private.png]]\n')
      await expect(guest.content(privateFile.file_id)).rejects.toMatchObject({ status: 404 })
      expect((await guest.create('Other.png', Buffer.from([1, 2, 3]))).status).toBe('rejected')
      await expect(
        guest.json('/group-assets', 'POST', { file_id: privateFile.file_id })
      ).rejects.toMatchObject({ status: 404 })
      const blob = await guest.upload(Buffer.from([4, 5, 6]))
      const publication = await guest.json(
        '/group-assets',
        'POST',
        { path: 'Public.png', ...blob, mtime: 1000 },
        { 'idempotency-key': 'publication' }
      )
      expect(publication.results[0].status).toBe('applied')
      expect(
        await guest.json(
          '/group-assets',
          'POST',
          { path: 'Public.png', ...blob, mtime: 1000 },
          { 'idempotency-key': 'publication' }
        )
      ).toEqual(publication)
      const asset = publication.results[0]
      expect(await guest.content(asset.file_id)).toEqual(Buffer.from([4, 5, 6]))
      expect((await guest.manifest()).items.map((i) => i.path)).not.toContain('Private.png')
      const changed = (
        await guest.commit([
          {
            op: 'modify',
            file_id: asset.file_id,
            base_version_id: asset.version_id,
            ...(await guest.upload(Buffer.from([7, 8]))),
            mtime: 2000,
          },
        ])
      ).results[0]!
      expect(changed.status).toBe('applied')
      expect(await owner.content(asset.file_id)).toEqual(Buffer.from([7, 8]))
      expect(await guest.content(asset.file_id)).toEqual(Buffer.from([7, 8]))
      const privateBlob = await guest.upload(Buffer.from([1, 2, 3]))
      const explicit = await guest.json(
        '/group-assets',
        'POST',
        { path: 'Private.png', ...privateBlob, mtime: 1000 },
        { 'idempotency-key': 'publish-existing-bytes' }
      )
      expect(explicit.results[0].file_id).toBe(privateFile.file_id)
      expect(await guest.content(privateFile.file_id)).toEqual(Buffer.from([1, 2, 3]))
      const child = await owner.create('Child.md', '---\ngroups: ["[[Groups/Root]]"]\n---\nchild\n')
      if (child.status === 'rejected') throw new Error(child.message)
      const childClient = new V2SyncClient(
        (
          await guest.json('/tokens', 'POST', {
            scope: { kind: 'group', id: child.file_id },
            label: 'Nested',
          })
        ).token
      )
      await owner.create('Nested.png', Buffer.from([10, 11]))
      const nested = await childClient.json(
        '/group-assets',
        'POST',
        { path: 'Nested.png', ...(await childClient.upload(Buffer.from([10, 11]))), mtime: 1000 },
        { 'idempotency-key': 'nested-publication' }
      )
      expect(await guest.content(nested.results[0].file_id)).toEqual(Buffer.from([10, 11]))
    })
    it('group history/trash/restore excludes private earlier versions and stale write-only departure bases never reveal private edits', async () => {
      const { owner, guest } = await setup()
      const note = await owner.create('Note.md', 'private earlier')
      if (note.status === 'rejected') throw new Error(note.message)
      const body = '---\ngroups: ["[[Groups/Root]]"]\n---\nshared\n'
      let shared = (
        await owner.commit([
          {
            op: 'modify',
            file_id: note.file_id,
            base_version_id: note.version_id,
            ...(await owner.upload(Buffer.from(body))),
            mtime: 2000,
          },
        ])
      ).results[0]!
      if (shared.status === 'rejected') throw new Error(shared.message)
      expect(
        (await guest.json(`/files/${note.file_id}/history`)).map(
          (v: { version_id: string }) => v.version_id
        )
      ).toEqual([shared.version_id])
      await expect(guest.content(note.file_id, note.version_id)).rejects.toMatchObject({
        status: 404,
      })
      await guest.commit([
        { op: 'delete', file_id: note.file_id, base_version_id: shared.version_id },
      ])
      expect((await guest.json('/trash')).map((v: { file_id: string }) => v.file_id)).toContain(
        note.file_id
      )
      shared = await guest.json(
        `/files/${note.file_id}/restore`,
        'POST',
        { deleted: true },
        { 'idempotency-key': 'group-restore' }
      )
      expect(shared.status).toBe('applied')
      if (shared.status === 'rejected') throw new Error(shared.message)
      const left = (
        await guest.commit([
          {
            op: 'modify',
            file_id: note.file_id,
            base_version_id: shared.version_id,
            ...(await guest.upload(Buffer.from('private departure'))),
            mtime: 3000,
          },
        ])
      ).results[0]!
      if (left.status === 'rejected') throw new Error(left.message)
      const hidden = (
        await owner.commit([
          {
            op: 'modify',
            file_id: note.file_id,
            base_version_id: left.version_id,
            ...(await owner.upload(Buffer.from('later PRIVATE bytes'))),
            mtime: 4000,
          },
        ])
      ).results[0]!
      expect(hidden.status).toBe('applied')
      expect((await guest.create('Note.md', body, 5000)).status).toBe('rejected')
      await expect(guest.content(note.file_id, left.version_id)).rejects.toMatchObject({
        status: 404,
      })
      expect((await owner.content(note.file_id)).toString()).toBe('later PRIVATE bytes')
    })
    it('subgroup removal produces a pageable removal for every descendant, while folder-inherited group boundaries remain enforced', async () => {
      const { owner, guest, group } = await setup()
      const child = await owner.create(
        'Groups/Child.md',
        '---\ngroups: ["[[Groups/Root]]"]\n---\nchild\n'
      )
      if (child.status === 'rejected') throw new Error(child.message)
      for (let i = 0; i < 5; i++)
        await owner.create(`Members/${i}.md`, '---\ngroups: ["[[Groups/Child]]"]\n---\nmember\n')
      const token = await guest.json('/tokens', 'POST', {
        scope: { kind: 'group', id: child.file_id },
        label: 'Subgroup',
      })
      const subgroup = new V2SyncClient(token.token)
      expect((await subgroup.manifest()).items).toHaveLength(6)
      const cursor = (await guest.manifest()).cursor
      await guest.commit([
        {
          op: 'modify',
          file_id: child.file_id,
          base_version_id: child.version_id,
          ...(await guest.upload(Buffer.from('child left'))),
          mtime: 2000,
        },
      ])
      const removals = []
      let since = cursor
      for (;;) {
        const page = await guest.changes(since, '&limit=1')
        removals.push(...page.items)
        since = page.cursor
        if (!page.next) break
      }
      expect(removals).toHaveLength(6)
      expect(removals.every((v) => v.type === 'removal')).toBe(true)
      expect((await subgroup.json('/connection')).status).toBe('scope_unavailable')
      const folder = (await owner.manifest()).items.find((i) => i.path === 'Groups')!
      const scopedFolder = new V2SyncClient((await owner.share(folder.file_id)).token)
      const confined = new V2SyncClient(
        (
          await scopedFolder.json('/tokens', 'POST', {
            scope: { kind: 'group', id: group.file_id },
            label: 'Confined',
          })
        ).token
      )
      const member = await owner.create(
        'Outside.md',
        '---\ngroups: ["[[Groups/Root]]"]\n---\noutside\n'
      )
      if (member.status === 'rejected') throw new Error(member.message)
      await expect(confined.content(member.file_id)).rejects.toMatchObject({ status: 404 })
      expect(
        (await confined.create('OutsideNew.md', '---\ngroups: ["[[Groups/Root]]"]\n---\nnew\n'))
          .status
      ).toBe('rejected')
      expect(
        (
          await confined.create(
            'Groups/Inside.md',
            '---\ngroups: ["[[Groups/Root]]"]\n---\ninside\n'
          )
        ).status
      ).toBe('applied')
    })
    it('deleting an intermediate group breaks inherited authority, not just its parent snapshot', async () => {
      const { owner, guest } = await setup()
      const middle = await owner.create(
        'Middle.md',
        '---\ngroups: ["[[Groups/Root]]"]\n---\nmiddle\n'
      )
      const child = await owner.create('Child.md', '---\ngroups: ["[[Middle]]"]\n---\nchild\n')
      if (middle.status === 'rejected' || child.status === 'rejected')
        throw new Error('create rejected')
      const token = await guest.json('/tokens', 'POST', {
        scope: { kind: 'group', id: child.file_id },
        label: 'Child',
      })
      const descendant = new V2SyncClient(token.token)
      expect((await descendant.json('/connection')).status).toBe('active')
      await owner.commit([
        { op: 'delete', file_id: middle.file_id, base_version_id: middle.version_id },
      ])
      expect((await guest.manifest()).items.map((i) => i.path)).not.toContain('Child.md')
      expect((await descendant.json('/connection')).status).toBe('scope_unavailable')
      await expect(descendant.manifest()).rejects.toMatchObject({ status: 503 })
    })
    it('cheap indexed closure: body edits do not rewrite edges or recompute unrelated roots; ambiguous and unresolved links never bind arbitrarily', async () => {
      const { owner, guest } = await setup()
      await owner.create('A/Duplicate.md', 'a')
      await owner.create('B/Duplicate.md', 'b')
      await owner.create('Ambiguous.md', '---\ngroups: ["[[Duplicate]]"]\n---\nambiguous\n')
      const pending = await owner.create(
        'Pending.md',
        '---\ngroups: ["[[Future]]"]\n---\npending\n'
      )
      const future = await owner.create('Future.md', 'future')
      if (future.status === 'rejected' || pending.status === 'rejected')
        throw new Error('create rejected')
      const token = await owner.json('/tokens', 'POST', {
        scope: { kind: 'group', id: future.file_id },
        label: 'Future',
      })
      expect((await new V2SyncClient(token.token).manifest()).items.map((i) => i.path)).toContain(
        'Pending.md'
      )
      const edges = await server.db.selectFrom('group_links').selectAll().execute()
      const before = (await guest.manifest()).cursor
      await owner.commit([
        {
          op: 'modify',
          file_id: pending.file_id,
          base_version_id: pending.version_id,
          ...(await owner.upload(Buffer.from('---\ngroups: ["[[Future]]"]\n---\nbody only\n'))),
          mtime: 2000,
        },
      ])
      expect(await server.db.selectFrom('group_links').selectAll().execute()).toEqual(edges)
      expect((await guest.changes(before)).items).toEqual([])
    })
  })
}
