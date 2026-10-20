import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { Connection033 } from '../helpers/protocol033.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { encodeAccessToken } from '@abele/sync-protocol'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`item sets (${dialect})`, () => {
    it('applies the item header to connection delete and refuses a conflicting delete selector', async () => {
      const f = await tokenFixture(dialect)
      try {
        const group = success(await f.root.create('Group.md', 'group'))
        const rootId = (await f.root.json('/connection')).token_id
        const item = await f.root.json(`/tokens/${rootId}/items`, 'POST', {
          scope: { kind: 'group', id: group.file_id },
        })
        const headers = { 'abele-scope-item': item.id, 'idempotency-key': randomUUID() }
        expect(
          (await f.root.request(`/connection/items/primary:${rootId}/delete`, 'POST', {}, headers))
            .status
        ).toBe(403)
        const result = await f.root.json('/connection/delete', 'POST', {}, headers)
        expect(result.files).toBe(1)
        expect(result.revoked_tokens).not.toContain(rootId)
        expect((await f.root.request('/manifest')).status).toBe(200)
      } finally {
        await f.close()
      }
    })
    it('selects group publication and folder content, and permits only the file item identity on writes', async () => {
      const f = await tokenFixture(dialect)
      try {
        const group = success(await f.root.create('Agents/Group.md', 'group'))
        const asset = success(await f.root.create('asset.bin', Buffer.from([1, 2, 3])))
        const added = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'group', id: group.file_id },
        })
        const headers = { 'abele-scope-item': added.id }
        expect(
          (await f.guest.request('/group-assets', 'POST', { file_id: asset.file_id }, headers))
            .status
        ).toBe(404)
        const blob = await f.guest.upload(Buffer.from([1, 2, 3]))
        await f.guest.json(
          '/group-assets',
          'POST',
          { path: 'asset.bin', ...blob, mtime: 1000 },
          { ...headers, 'idempotency-key': randomUUID() }
        )
        expect(
          (await f.guest.json('/group-assets', 'POST', { file_id: asset.file_id }, headers))
            .published
        ).toBe(true)
        expect(
          (await f.guest.json('/manifest', 'GET', undefined, headers)).items.map(
            (i: { file_id: string }) => i.file_id
          )
        ).toContain(asset.file_id)
        const folder = success((await f.root.commit([{ op: 'mkdir', path: 'Other' }])).results[0]!)
        const file = success(await f.root.create('Other/one.md', 'one'))
        const folderItem = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'folder', id: folder.file_id },
        })
        expect(
          (
            await f.guest.json('/manifest', 'GET', undefined, { 'abele-scope-item': folderItem.id })
          ).items.map((i: { file_id: string }) => i.file_id)
        ).toContain(file.file_id)
        const fileShare = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'file', id: file.file_id },
          label: 'File',
        })
        const client = new V2SyncClient(fileShare.token)
        const moved = success(
          (
            await client.commit([
              {
                op: 'move',
                file_id: file.file_id,
                base_version_id: file.version_id,
                to_path: 'Other/renamed.md',
              },
            ])
          ).results[0]!
        )
        expect((await client.manifest()).items.map((i) => i.path)).toEqual(['Other/renamed.md'])
        expect(
          success(
            (
              await client.commit([
                { op: 'delete', file_id: file.file_id, base_version_id: moved.version_id },
              ])
            ).results[0]!
          ).status
        ).toBe('applied')
        expect((await client.changes()).items).toContainEqual(
          expect.objectContaining({ type: 'delete', file_id: file.file_id })
        )
      } finally {
        await f.close()
      }
    })
    it('absorbs narrower items when adding a broader folder, without removal events', async () => {
      const f = await tokenFixture(dialect)
      try {
        const dir = success(
          (await f.root.commit([{ op: 'mkdir', path: 'Agents/Nested' }])).results[0]!
        )
        const child = await f.root.share(dir.file_id)
        const client = new V2SyncClient(child.token)
        const primary = (await client.json('/connection/items')).items[0].id
        const before = await f.t.db.selectFrom('scope_changes').selectAll().execute()
        const item = await f.root.json(`/tokens/${child.info.id}/items`, 'POST', {
          scope: { kind: 'folder', id: f.share.info.scope.id },
        })
        expect(
          (await client.request('/manifest', 'GET', undefined, { 'abele-scope-item': primary }))
            .status
        ).toBe(403)
        expect(
          (await client.request('/manifest', 'GET', undefined, { 'abele-scope-item': item.id }))
            .status
        ).toBe(200)
        expect(await f.t.db.selectFrom('scope_changes').selectAll().execute()).toEqual(before)
      } finally {
        await f.close()
      }
    })
    it('binds idempotency receipts to the item and keeps file moves inside inherited boundaries', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('Agents/one.md', 'one'))
        const childShare = await f.guest.json('/tokens', 'POST', {
          scope: { kind: 'file', id: file.file_id },
          label: 'File',
        })
        const child = new V2SyncClient(childShare.token)
        const result = await child.commit([
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'Private.md',
          },
        ])
        expect(result.results[0]!.status).toBe('rejected')
        const outside = success(await f.root.create('outside.md', 'outside'))
        const item = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: outside.file_id },
        })
        const key = randomUUID()
        const ops = { ops: [{ op: 'delete', file_id: 'missing', base_version_id: 'missing' }] }
        await f.guest.json('/commit', 'POST', ops, { 'idempotency-key': key })
        const replay = await f.guest.request('/commit', 'POST', ops, {
          'idempotency-key': key,
          'abele-scope-item': item.id,
        })
        expect(replay.status).toBe(422)
        expect(await replay.json()).toMatchObject({ error: { code: 'idempotency_mismatch' } })
      } finally {
        await f.close()
      }
    })
    it('limits commit, changes, group-assets and foreign item access; inherits read-only', async () => {
      const f = await tokenFixture(dialect)
      try {
        const a = success(await f.root.create('one.md', 'one'))
        const b = success(await f.root.create('two.md', 'two'))
        const added = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: a.file_id },
        })
        const headers = { 'abele-scope-item': added.id }
        expect((await f.root.request('/manifest', 'GET', undefined, headers)).status).toBe(403)
        expect(
          (await f.guest.request('/group-assets', 'POST', { file_id: b.file_id }, headers)).status
        ).toBe(403)
        const result = await f.guest.json(
          '/commit',
          'POST',
          { ops: [{ op: 'delete', file_id: b.file_id, base_version_id: b.version_id }] },
          { ...headers, 'idempotency-key': randomUUID() }
        )
        expect(result.results[0]!.status).toBe('rejected')
        const moved = success(
          (
            await f.root.commit([
              {
                op: 'move',
                file_id: a.file_id,
                base_version_id: a.version_id,
                to_path: 'moved.md',
              },
            ])
          ).results[0]!
        )
        const feed = await f.guest.json('/changes?since=0', 'GET', undefined, headers)
        expect(JSON.stringify(feed)).toContain(a.file_id)
        expect(JSON.stringify(feed)).not.toContain(b.file_id)
        const reader = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'folder', id: f.share.info.scope.id },
          label: 'Reader',
          read_only: true,
        })
        const readerItem = await f.root.json(`/tokens/${reader.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: a.file_id },
        })
        const client = new V2SyncClient(reader.token)
        expect(
          (
            await client.request(
              '/commit',
              'POST',
              { ops: [] },
              { 'abele-scope-item': readerItem.id }
            )
          ).status
        ).toBe(403)
        await f.root.commit([
          { op: 'delete', file_id: a.file_id, base_version_id: moved.version_id },
        ])
        await f.root.create('moved.md', 'replacement')
        expect((await f.guest.request('/manifest', 'GET', undefined, headers)).status).toBe(503)
      } finally {
        await f.close()
      }
    })
    it('deletes one item as owner, keeps the key and other items, revokes nested keys, and replays safely', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('one.md', 'one'))
        const item = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        const child = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'file', id: file.file_id },
          label: 'Nested',
        })
        const inheriting = await f.root.share(f.share.info.scope.id)
        await f.root.json(`/tokens/${inheriting.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        const route = `/connection/items/${item.id}/delete`
        const headers = { 'idempotency-key': randomUUID() }
        expect((await f.guest.request(route, 'POST', {}, headers)).status).toBe(403)
        const result = await f.root.json(route, 'POST', {}, headers)
        expect(result.files).toBe(1)
        expect(result.revoked_tokens).toContain(child.info.id)
        expect(result.revoked_tokens).toContain(inheriting.info.id)
        expect(result.revoked_tokens).not.toContain(f.share.info.id)
        expect(await f.root.json(route, 'POST', {}, headers)).toEqual(result)
        expect((await f.guest.request('/manifest')).status).toBe(200)
        expect((await f.root.request(`/files/${file.file_id}/content`)).status).toBe(404)
        expect((await new V2SyncClient(child.token).request('/connection')).status).toBe(401)
      } finally {
        await f.close()
      }
    })
    it('removes the implicit primary while another item remains live', async () => {
      const f = await tokenFixture(dialect)
      try {
        const file = success(await f.root.create('outside.md', 'outside'))
        const item = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        const primary = (await f.guest.json('/connection/items')).items[0].id
        await f.root.json(`/tokens/${f.share.info.id}/items/${primary}`, 'DELETE')
        expect((await f.guest.json('/connection/items')).items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: item.id, removed_at: null }),
            expect.objectContaining({ id: primary, removed_at: expect.any(String) }),
          ])
        )
        expect(
          (await f.guest.json('/connection/items')).items.find(
            (entry: { id: string }) => entry.id === primary
          ).scope.path
        ).toBe('(unavailable)')
        for (const route of ['/connection', '/manifest', '/changes'])
          expect((await f.guest.request(route)).status).toBe(403)
        expect(
          (await f.guest.request('/manifest', 'GET', undefined, { 'abele-scope-item': item.id }))
            .status
        ).toBe(200)
        expect(
          (
            await f.guest.request('/connection/items', 'GET', undefined, {
              'abele-scope-item': primary,
            })
          ).status
        ).toBe(403)
        await f.root.json(`/tokens/${f.share.info.id}/items/${item.id}`, 'DELETE')
        expect(
          (await f.guest.json('/connection/items')).items.every(
            (entry: { removed_at: string | null }) => entry.removed_at !== null
          )
        ).toBe(true)
        const restored = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        expect((await f.guest.json('/connection/items')).items).toContainEqual(
          expect.objectContaining({ id: restored.id, removed_at: null })
        )
      } finally {
        await f.close()
      }
    })
    it('websocket hello subscribes to the selected item and closes on detach', async () => {
      const f = await tokenFixture(dialect)
      let socket: WebSocket | undefined
      try {
        const file = success(await f.root.create('one.md', 'one'))
        const item = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: file.file_id },
        })
        await f.root.commit([
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'renamed.md',
          },
        ])
        const last = await f.t.db
          .selectFrom('scope_changes')
          .select('cursor')
          .where('scope_id', '=', item.scope_id)
          .orderBy('cursor', 'desc')
          .executeTakeFirstOrThrow()
        socket = new WebSocket(f.t.address.replace('http:', 'ws:') + '/v2/events')
        const event = new Promise<string>((resolve, reject) => {
          socket!.once('message', (data) => resolve(data.toString()))
          socket!.once('error', reject)
        })
        socket.once('open', () =>
          socket!.send(JSON.stringify({ token: f.guest.key, item: item.id }))
        )
        expect(JSON.parse(await event)).toEqual({ type: 'changes', cursor: last.cursor })
        const closed = new Promise<number>((resolve) => socket!.once('close', resolve))
        await f.root.json(`/tokens/${f.share.info.id}/items/${item.id}`, 'DELETE')
        expect(await closed).toBe(4003)
      } finally {
        socket?.terminate()
        await f.close()
      }
    })
    it('selects a file, preserves legacy connection, and detaches without events', async () => {
      const f = await tokenFixture(dialect)
      try {
        const a = success(await f.root.create('one.md', 'one'))
        const b = success(await f.root.create('two.md', 'two'))
        const added = await f.root.json(`/tokens/${f.share.info.id}/items`, 'POST', {
          scope: { kind: 'file', id: a.file_id },
        })
        const headers = { 'abele-scope-item': added.id }
        expect(Connection033.parse(await f.root.json('/connection')).scope.kind).toBe('folder')
        expect(Connection033.parse(await f.guest.json('/connection')).scope.kind).toBe('folder')
        const setClient = new V2SyncClient(
          encodeAccessToken({
            v: 2,
            address: f.t.address,
            key: f.guest.key,
            items: [{ id: added.id, scope_id: added.scope_id, kind: 'file', path: 'one.md' }],
          })
        )
        expect(Connection033.parse(await setClient.json('/connection')).scope.kind).toBe('folder')
        expect((await f.guest.json('/connection/items')).items).toHaveLength(2)
        expect(
          (await f.guest.json('/manifest', 'GET', undefined, headers)).items.map(
            (i: { file_id: string }) => i.file_id
          )
        ).toEqual([a.file_id])
        for (const route of ['content', 'history'])
          expect(
            (await f.guest.request(`/files/${b.file_id}/${route}`, 'GET', undefined, headers))
              .status
          ).toBe(404)
        await f.root.commit([
          { op: 'move', file_id: a.file_id, base_version_id: a.version_id, to_path: 'renamed.md' },
        ])
        expect((await f.guest.json('/manifest', 'GET', undefined, headers)).items[0].path).toBe(
          'renamed.md'
        )
        const before = await f.t.db.selectFrom('scope_changes').selectAll().execute()
        await f.root.json(`/tokens/${f.share.info.id}/items/${added.id}`, 'DELETE')
        const response = await f.guest.request('/manifest', 'GET', undefined, headers)
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({
          error: { code: 'forbidden', details: { reason: 'scope_removed' } },
        })
        expect(await f.t.db.selectFrom('scope_changes').selectAll().execute()).toEqual(before)
        expect((await f.guest.request('/manifest')).status).toBe(200)
      } finally {
        await f.close()
      }
    })
    it('refuses recipient edits, duplicates, covered folders and escaped grants', async () => {
      const f = await tokenFixture(dialect)
      try {
        const nested = success(
          (await f.root.commit([{ op: 'mkdir', path: 'Agents/Nested' }])).results[0]!
        )
        const outside = success(
          (await f.root.commit([{ op: 'mkdir', path: 'Private' }])).results[0]!
        )
        const route = `/tokens/${f.share.info.id}/items`
        expect(
          (await f.guest.request(route, 'POST', { scope: { kind: 'folder', id: outside.file_id } }))
            .status
        ).toBe(403)
        for (const id of [f.share.info.scope.id, nested.file_id])
          expect(
            (await f.root.request(route, 'POST', { scope: { kind: 'folder', id } })).status
          ).toBe(403)
        const child = await f.guest.share(nested.file_id)
        expect(
          (
            await f.guest.request(`/tokens/${child.info.id}/items`, 'POST', {
              scope: { kind: 'folder', id: outside.file_id },
            })
          ).status
        ).toBe(403)
      } finally {
        await f.close()
      }
    })
  })
}
