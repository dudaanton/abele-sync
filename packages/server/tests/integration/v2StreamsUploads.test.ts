import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { V2EventSchema, type V2Event } from '@abele/sync-protocol'
import { createUser } from '../../src/access/tokens.js'
import { v2Server, type V2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await sleep(20)
  expect(predicate()).toBe(true)
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`v2 streams/uploads (${dialect})`, () => {
    let server: V2Server | undefined
    const sockets: WebSocket[] = []
    afterEach(async () => {
      await Promise.all(
        sockets.splice(0).map((socket) => {
          if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
          return new Promise<void>((resolve) => {
            socket.once('close', () => resolve())
            socket.terminate()
          })
        })
      )
      await server?.close()
      server = undefined
    })
    async function setup() {
      server = await v2Server(dialect)
      const issued = await createUser(
        { db: server.db, dialect, pepper: server.config.tokenPepper },
        'Owner',
        server.address
      )
      const owner = new V2SyncClient(issued.token)
      const dir = (await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!
      if (dir.status === 'rejected') throw new Error(dir.message)
      const share = await owner.share(dir.file_id)
      const guest = new V2SyncClient(share.token)
      return { owner, guest, share, dir }
    }
    async function listen(client: V2SyncClient) {
      const socket = new WebSocket(client.address.replace('http:', 'ws:') + '/v2/events', {
        headers: { authorization: 'Bearer ' + client.key },
      })
      sockets.push(socket)
      const events: V2Event[] = []
      socket.on('message', (data) => events.push(V2EventSchema.parse(JSON.parse(data.toString()))))
      await once(socket, 'open')
      await until(() => events.length > 0)
      return { socket, events }
    }
    it('closes active group sockets before destroying the server database pool', async () => {
      const { owner } = await setup()
      const root = await owner.create('Shared/G.md', 'group root')
      if (root.status === 'rejected') throw new Error(root.message)
      const share = await owner.json('/tokens', 'POST', {
        scope: { kind: 'group', id: root.file_id },
        label: 'Group',
      })
      const group = new V2SyncClient(share.token)
      await listen(group)
      const space = (await owner.json('/connection')).space_id
      expect(server!.hub.sockets(space)).toBe(1)
      const destroy = server!.db.destroy.bind(server!.db)
      const attachedAtPoolClose: number[] = []
      const spy = vi.spyOn(server!.db, 'destroy').mockImplementation(async () => {
        attachedAtPoolClose.push(server!.hub.sockets(space))
        await destroy()
      })
      try {
        await server!.close()
        expect(attachedAtPoolClose.length).toBeGreaterThan(0)
        expect(attachedAtPoolClose.every((count) => count === 0)).toBe(true)
      } finally {
        spy.mockRestore()
      }
    })
    it('browser/mobile hello authenticates before any notification or subscription', async () => {
      const { guest } = await setup()
      const socket = new WebSocket(guest.address.replace('http:', 'ws:') + '/v2/events')
      sockets.push(socket)
      const events: V2Event[] = []
      socket.on('message', (data) => events.push(V2EventSchema.parse(JSON.parse(data.toString()))))
      await once(socket, 'open')
      await sleep(30)
      expect(events).toEqual([])
      socket.send(JSON.stringify({ token: guest.key }))
      await until(() => events.length > 0)
      expect(events[0]).toEqual({ type: 'changes', cursor: 0 })
    })
    it('notifies only scoped changes, revocation sends connection state and closes only that token stream', async () => {
      const { owner, guest, share, dir } = await setup()
      const peer = new V2SyncClient((await guest.share(dir.file_id)).token)
      const a = await listen(guest),
        b = await listen(peer)
      await owner.create('Private.md', 'not observable')
      await sleep(400)
      expect(a.events).toEqual([{ type: 'changes', cursor: 0 }])
      const result = await peer.create('Shared/Public.md', 'public')
      if (result.status === 'rejected') throw new Error(result.message)
      await until(() => a.events.some((e) => e.type === 'changes' && e.cursor > 0))
      const closed = once(a.socket, 'close')
      await owner.json('/tokens/' + share.info.id, 'DELETE')
      await closed
      expect(a.events.at(-1)).toEqual({ type: 'connection', status: 'revoked' })
      expect(b.socket.readyState).toBe(WebSocket.OPEN)
      const cursor = b.events.filter((e) => e.type === 'changes').at(-1)!
      await peer.create('Shared/Another.md', 'continues')
      await until(() =>
        b.events.some(
          (e) => e.type === 'changes' && cursor.type === 'changes' && e.cursor > cursor.cursor
        )
      )
    })
    it('deleted shared folder exposes genuine final deletes before unavailable state; replacement path does not revive identity', async () => {
      const { owner, guest, dir } = await setup()
      await guest.create('Shared/Note.md', 'retained locally')
      const a = await listen(guest)
      const before = (await guest.manifest()).cursor
      const closed = once(a.socket, 'close')
      await owner.commit([
        { op: 'delete_directory', file_id: dir.file_id, base_version_id: dir.version_id },
      ])
      await closed
      expect(a.events.at(-1)).toEqual({ type: 'connection', status: 'scope_unavailable' })
      const final = await guest.changes(before)
      expect(final.items.map((i) => [i.type, i.path]).sort()).toEqual([
        ['delete', 'Shared'],
        ['delete', 'Shared/Note.md'],
      ])
      expect(a.events).toContainEqual({ type: 'changes', cursor: final.cursor })
      await owner.commit([{ op: 'mkdir', path: 'Shared' }])
      expect((await guest.json('/connection')).status).toBe('scope_unavailable')
      await expect(guest.manifest()).rejects.toMatchObject({ status: 503 })
    })
    for (const hello of [false, true])
      it(`review 7: active group ${hello ? 'hello' : 'header'} sockets receive scoped cursors, independent revocation and unavailable-root state`, async () => {
        const { owner } = await setup()
        const root = await owner.create('Shared/G.md', 'group root')
        if (root.status === 'rejected') throw new Error(root.message)
        const share = await owner.json('/tokens', 'POST', {
          scope: { kind: 'group', id: root.file_id },
          label: 'Group',
        })
        const group = new V2SyncClient(share.token)
        const peer = new V2SyncClient(
          (
            await group.json('/tokens', 'POST', {
              scope: { kind: 'group', id: root.file_id },
              label: 'Peer',
            })
          ).token
        )
        let a: { socket: WebSocket; events: V2Event[] }
        if (hello) {
          const socket = new WebSocket(group.address.replace('http:', 'ws:') + '/v2/events')
          sockets.push(socket)
          const events: V2Event[] = []
          socket.on('message', (data) =>
            events.push(V2EventSchema.parse(JSON.parse(data.toString())))
          )
          await once(socket, 'open')
          expect(events).toEqual([])
          socket.send(JSON.stringify({ token: group.key }))
          await until(() => events.length > 0)
          a = { socket, events }
        } else a = await listen(group)
        expect(a.events[0]).toEqual({ type: 'changes', cursor: 0 })
        expect(a.socket.readyState).toBe(WebSocket.OPEN)
        const b = await listen(peer)
        await owner.create('Private.md', 'not observable')
        await sleep(100)
        expect(a.events).toEqual([{ type: 'changes', cursor: 0 }])
        const note = await group.create(
          'Shared/N.md',
          '---\ngroups: ["[[Shared/G]]"]\n---\nmember\n'
        )
        if (note.status === 'rejected') throw new Error(note.message)
        await until(() => a.events.some((e) => e.type === 'changes' && e.cursor > 0))
        const scoped = (await group.changes(0)).items.at(-1)!.cursor
        expect(a.events).toContainEqual({ type: 'changes', cursor: scoped })
        const closed = once(a.socket, 'close')
        await owner.json('/tokens/' + share.info.id, 'DELETE')
        expect((await closed)[0]).toBe(4001)
        expect(a.events.at(-1)).toEqual({ type: 'connection', status: 'revoked' })
        expect(b.socket.readyState).toBe(WebSocket.OPEN)
        const gone = once(b.socket, 'close')
        await owner.commit([
          { op: 'delete', file_id: root.file_id, base_version_id: root.version_id },
        ])
        expect((await gone)[0]).toBe(4003)
        expect(b.events.at(-1)).toEqual({ type: 'connection', status: 'scope_unavailable' })
      })
    it('multipart admission observes space file limits, not only the process limit', async () => {
      const { owner, guest } = await setup()
      const connection = await owner.json('/connection')
      const row = await server!.db
        .selectFrom('spaces')
        .select('settings')
        .where('id', '=', connection.space_id)
        .executeTakeFirstOrThrow()
      await server!.db
        .updateTable('spaces')
        .set({ settings: JSON.stringify({ ...JSON.parse(row.settings), max_file_bytes: 3 }) })
        .where('id', '=', connection.space_id)
        .execute()
      const body = Buffer.from('too large')
      const sha = createHash('sha256').update(body).digest('hex')
      await expect(
        guest.json(`/uploads/${sha}/begin`, 'POST', { size: body.length })
      ).rejects.toMatchObject({ status: 413 })
      expect(await server!.db.selectFrom('uploads').selectAll().execute()).toEqual([])
    })
    it('multipart ownership includes token, space and sha; digest knowledge cannot complete missing bytes', async () => {
      const { owner, guest, dir } = await setup()
      const peer = new V2SyncClient((await guest.share(dir.file_id)).token)
      const body = Buffer.from('multipart')
      const sha = createHash('sha256').update(body).digest('hex')
      const begin = await guest.json(`/uploads/${sha}/begin`, 'POST', { size: body.length })
      await expect(
        peer.json(`/uploads/${sha}/${begin.upload_id}/0`, 'PUT', body)
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        guest.json(`/uploads/${'a'.repeat(64)}/${begin.upload_id}/0`, 'PUT', body)
      ).rejects.toMatchObject({ status: 404 })
      await expect(
        guest.json(`/uploads/${sha}/${begin.upload_id}/complete`, 'POST')
      ).rejects.toMatchObject({ status: 400 })
      expect(
        (await guest.request(`/uploads/${sha}/${begin.upload_id}/0`, 'PUT', body)).status
      ).toBe(204)
      expect(await guest.json(`/uploads/${sha}/${begin.upload_id}/complete`, 'POST')).toEqual({
        sha,
        size: body.length,
      })
      const file = (
        await guest.commit([
          { op: 'create', path: 'Shared/Blob.bin', sha, size: body.length, mtime: 1000 },
        ])
      ).results[0]!
      if (file.status === 'rejected') throw new Error(file.message)
      expect(await peer.content(file.file_id)).toEqual(body)
      const range = await guest.request(`/files/${file.file_id}/content`, 'GET', undefined, {
        range: 'bytes=2-5',
      })
      expect(range.status).toBe(206)
      expect(Buffer.from(await range.arrayBuffer())).toEqual(body.subarray(2, 6))
      expect(await owner.content(file.file_id)).toEqual(body)
    })
  })
