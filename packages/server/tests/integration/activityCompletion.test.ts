import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { once } from 'node:events'
import { type ServerResponse } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { registerActivity } from '../../src/history/activity.js'
import { tokenFixture } from '../helpers/tokenFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`transfer completion (${dialect})`, () => {
    it('does not wait for the abandoned HTTP response after a WebSocket upgrade', async () => {
      const f = await tokenFixture(dialect)
      const app = Fastify()
      await app.register(websocket)
      let response!: ServerResponse
      app.addHook('onRequest', async (request, reply) => {
        if (!request.ws) return
        response = reply.raw
        // Ownership transfers to the WebSocket. Its HTTP response need not
        // receive a close event when the upgraded transport closes.
        response.detachSocket(response.socket!)
      })
      registerActivity(app, {
        db: f.t.db,
        config: f.t.config,
        store: f.t.store,
        hub: f.t.hub,
        dialect,
      })
      app.get('/events', { websocket: true }, (socket) => socket.send('ready'))
      try {
        await app.ready()
        const socket = await app.injectWS('/events')
        const closed = once(socket, 'close')
        socket.terminate()
        await closed
        expect(response.closed).toBe(false)
        expect(response.listenerCount('close')).toBe(0)
        await app.close()
      } finally {
        response?.emit('close')
        await app.close()
        await f.close()
      }
    })
    it('does not wait for a response that closed before the activity hook ran', async () => {
      const f = await tokenFixture(dialect)
      const app = Fastify()
      let response!: ServerResponse
      let checked!: () => void
      const activityReached = new Promise<void>((resolve) => {
        checked = resolve
      })
      app.addHook('onRequest', async (_request, reply) => {
        response = reply.raw
        const closed = once(response, 'close')
        response.destroy()
        await closed
      })
      registerActivity(app, {
        db: f.t.db,
        config: f.t.config,
        store: f.t.store,
        hub: f.t.hub,
        dialect,
      })
      app.addHook('onRequest', async () => checked())
      app.get('/closed', () => 'not delivered')
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        await expect(fetch(address + '/closed')).rejects.toBeInstanceOf(Error)
        await activityReached
        expect(response.closed).toBe(true)
        // A listener added after close can never release the shutdown drain.
        expect(response.listenerCount('close')).toBe(0)
        await app.close()
      } finally {
        // Release the old implementation's stranded drain after the red assertion.
        response?.emit('close')
        app.server.closeAllConnections()
        await app.close()
        await f.close()
      }
    })
    it('excludes aborted streams, HEADs and errors while counting completed downloads once', async () => {
      const f = await tokenFixture(dialect)
      const app = Fastify()
      let closed!: () => void
      const abortedClosed = new Promise<void>((resolve) => {
        closed = resolve
      })
      let errorClosed!: () => void, failStream!: () => void
      const failedClosed = new Promise<void>((resolve) => {
        errorClosed = resolve
      })
      let finishes = 0
      app.addHook('onRequest', async (request, reply) => {
        request.tokenActivity = { vaultId: f.space, tokenId: f.share.info.id }
        reply.raw.once('finish', () => {
          finishes++
        })
      })
      registerActivity(app, {
        db: f.t.db,
        config: f.t.config,
        store: f.t.store,
        hub: f.t.hub,
        dialect,
      })
      app.get<{ Params: { id: string } }>('/v2/files/:id/content', (request, reply) => {
        if (request.params.id === 'error') return reply.code(416).send({ error: 'invalid range' })
        reply.header('content-length', '5')
        if (request.params.id === 'abort' || request.params.id === 'stream-error') {
          const body = new PassThrough()
          reply.raw.once('close', () => {
            body.destroy()
            if (request.params.id === 'abort') closed()
            else errorClosed()
          })
          failStream = () => {
            // Fastify dispatches onResponse for this error too, with status 200.
            reply.hijack()
            reply.raw.emit('error', new Error('controlled response failure'))
            reply.raw.destroy()
          }
          body.write('h')
          return reply.send(body)
        }
        return reply.send(Readable.from(['hello']))
      })
      const controller = new AbortController()
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const response = await fetch(address + '/v2/files/abort/content', {
          signal: controller.signal,
        })
        expect(response.status).toBe(200)
        const reader = response.body!.getReader()
        expect((await reader.read()).value).toEqual(new Uint8Array(Buffer.from('h')))
        controller.abort()
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
        await abortedClosed
        expect(finishes).toBe(0)
        const failed = await fetch(address + '/v2/files/stream-error/content')
        expect(failed.status).toBe(200)
        const failedReader = failed.body!.getReader()
        expect((await failedReader.read()).value).toEqual(new Uint8Array(Buffer.from('h')))
        failStream()
        await expect(failedReader.read()).rejects.toBeInstanceOf(Error)
        await failedClosed
        expect(finishes).toBe(0)
        const head = await fetch(address + '/v2/files/file/content', { method: 'HEAD' })
        expect(head.status).toBe(200)
        expect(await head.text()).toBe('')
        const error = await fetch(address + '/v2/files/error/content')
        expect(error.status).toBe(416)
        await error.arrayBuffer()
        const good = await fetch(address + '/v2/files/file/content')
        expect(await good.text()).toBe('hello')
        // Closing also drains the counter queue, so a late duplicate would be observable.
        await app.close()
        expect(
          await f.t.db
            .selectFrom('activity_daily')
            .selectAll()
            .where('token_id', '=', f.share.info.id)
            .executeTakeFirst()
        ).toMatchObject({ downloaded_files: 1, downloaded_bytes: 5 })
      } finally {
        controller.abort()
        app.server.closeAllConnections()
        await app.close()
        await f.close()
      }
    })
    it('counts finished responses even when writableFinished has not caught up, without losing coalescing', async () => {
      const f = await tokenFixture(dialect)
      const app = Fastify()
      let finishes = 0,
        delayedFlags = 0
      app.addHook('onRequest', async (request, reply) => {
        request.tokenActivity = { vaultId: f.space, tokenId: f.share.info.id }
        reply.raw.once('finish', () => {
          finishes++
        })
      })
      // Model the Node/socket ordering seen on Linux: onResponse is running
      // because finish fired, but its writableFinished snapshot is still false.
      app.addHook('onResponse', async (_request, reply) => {
        if (delayedFlags < 3) {
          delayedFlags++
          Object.defineProperty(reply.raw, 'writableFinished', { value: false, configurable: true })
        }
      })
      registerActivity(app, {
        db: f.t.db,
        config: f.t.config,
        store: f.t.store,
        hub: f.t.hub,
        dialect,
      })
      app.addHook('onResponse', async (_request, reply) => {
        Reflect.deleteProperty(reply.raw, 'writableFinished')
      })
      app.get('/v2/files/:id/content', (_request, reply) =>
        reply.header('content-length', '5').send(Readable.from(['hello']))
      )
      const writes = vi.spyOn(f.t.db, 'insertInto')
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        for (let i = 0; i < 20; i++) {
          const response = await fetch(address + '/v2/files/file/content', {
            headers: { connection: 'close' },
          })
          expect(response.status).toBe(200)
          expect(await response.text()).toBe('hello')
        }
        expect(finishes).toBe(20)
        expect(delayedFlags).toBe(3)
        await app.close()
        expect(
          await f.t.db
            .selectFrom('activity_daily')
            .selectAll()
            .where('token_id', '=', f.share.info.id)
            .executeTakeFirst()
        ).toMatchObject({ downloaded_files: 20, downloaded_bytes: 100 })
        expect(
          writes.mock.calls.filter(([table]) => table === 'activity_daily').length
        ).toBeLessThan(20)
      } finally {
        await app.close()
        writes.mockRestore()
        await f.close()
      }
    })
    it('counts a download whose client has every byte before the server ends the response', async () => {
      // A client that has read the whole Content-Length body may close the
      // connection before the server's pipe calls end(): the response then
      // closes without 'finish'. Every byte was delivered, so it is a download.
      const f = await tokenFixture(dialect)
      const app = Fastify()
      const bodies = new Map<string, PassThrough>()
      const responsesClosed = new Map<string, Promise<void>>()
      let finishes = 0
      app.addHook('onRequest', async (request, reply) => {
        request.tokenActivity = { vaultId: f.space, tokenId: f.share.info.id }
        reply.raw.once('finish', () => {
          finishes++
        })
      })
      registerActivity(app, {
        db: f.t.db,
        config: f.t.config,
        store: f.t.store,
        hub: f.t.hub,
        dialect,
      })
      app.get<{ Params: { id: string } }>('/v2/files/:id/content', (request, reply) => {
        const body = new PassThrough()
        bodies.set(request.params.id, body)
        responsesClosed.set(
          request.params.id,
          new Promise((resolve) => reply.raw.once('close', () => resolve()))
        )
        reply.raw.once('close', () => body.destroy())
        // The source has not ended yet: only the declared bytes are on the wire.
        body.write(request.params.id === 'partial' ? 'hell' : 'hello')
        return reply.header('content-length', '5').send(body)
      })
      const controller = new AbortController()
      try {
        const address = await app.listen({ host: '127.0.0.1', port: 0 })
        const delivered = await fetch(address + '/v2/files/delivered/content', {
          headers: { connection: 'close' },
        })
        expect(await delivered.text()).toBe('hello')
        await responsesClosed.get('delivered')
        // Four of five bytes and an abort is not a download.
        const partial = await fetch(address + '/v2/files/partial/content', {
          signal: controller.signal,
        })
        const reader = partial.body!.getReader()
        expect((await reader.read()).value).toEqual(new Uint8Array(Buffer.from('hell')))
        controller.abort()
        await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
        await responsesClosed.get('partial')
        // Shutting down while a fully delivered response is still open must
        // still count it before the counters are drained.
        const atShutdown = await fetch(address + '/v2/files/shutdown/content', {
          headers: { connection: 'close' },
        })
        expect(await atShutdown.text()).toBe('hello')
        const closed = app.close()
        app.server.closeAllConnections()
        await closed
        expect(finishes).toBe(0)
        expect(
          await f.t.db
            .selectFrom('activity_daily')
            .selectAll()
            .where('token_id', '=', f.share.info.id)
            .executeTakeFirst()
        ).toMatchObject({ downloaded_files: 2, downloaded_bytes: 10 })
      } finally {
        controller.abort()
        for (const body of bodies.values()) body.destroy()
        app.server.closeAllConnections()
        await app.close()
        await f.close()
      }
    })
  })
