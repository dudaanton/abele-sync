import { recordUse } from '../../history/activity.js'
import { AbeleError, type V2Event } from '@abele/sync-protocol'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { folderWasDeleted } from '../../access/visibility.js'
import { authenticateToken, connection } from '../../access/tokens.js'
import { accessDeps, bearerKey } from './v2Tokens.js'
import type { AppDeps } from '../app.js'

/** Browser/mobile sockets authenticate with hello {token:key}; native callers may
 * authenticate the upgrade header. No content or subscription exists before auth. */
export function registerV2EventRoutes(app: FastifyInstance, deps: AppDeps) {
  const access = accessDeps(deps)
  app.get('/v2/events', { websocket: true }, (socket, request) => {
    let key: string | null = request.headers.authorization ? bearerKey(request) : null
    let ended = false,
      started = false,
      detach = () => {},
      last = -1
    let pending = Promise.resolve()
    const send = (event: V2Event) => {
      if (!ended) socket.send(JSON.stringify(event))
    }
    const stop = (code: number, revoked: boolean) => {
      if (ended) return
      if (revoked && started)
        send({ type: 'connection', status: code === 4004 ? 'scope_deleted' : 'revoked' })
      ended = true
      detach()
      clearInterval(timer)
      clearTimeout(authTimeout)
      socket.close(code)
    }
    const check = () => {
      pending = pending
        .then(async () => {
          if (ended || key === null) return
          const p = await authenticateToken(access, key)
          const state = await connection(access, p)
          if (state.status !== 'active') {
            if (await folderWasDeleted(access, p.scope)) {
              const final = await deps.db
                .selectFrom('scope_changes')
                .select('cursor')
                .where('scope_id', '=', p.scope.id)
                .orderBy('cursor', 'desc')
                .executeTakeFirst()
              if (final && final.cursor > last) send({ type: 'changes', cursor: final.cursor })
            }
            send({ type: 'connection', status: state.status })
            stop(4003, false)
            return
          }
          const row = await deps.db
            .selectFrom('scope_changes')
            .select('cursor')
            .where('scope_id', '=', p.scope.id)
            .orderBy('cursor', 'desc')
            .executeTakeFirst()
          const cursor = row?.cursor ?? 0
          if (cursor > last) {
            send({ type: 'changes', cursor })
            last = cursor
          }
        })
        .catch((error) => {
          if (error instanceof AbeleError && error.code === 'scope_deleted') stop(4004, true)
          else if (error instanceof AbeleError && error.code === 'unauthorized') stop(4001, true)
          else stop(1011, false)
        })
    }
    // Also catches local administration; no long-lived credential cache.
    const timer = setInterval(check, 1000)
    timer.unref()
    const authTimeout = setTimeout(() => stop(4001, false), deps.config.wsHelloTimeoutMs)
    authTimeout.unref()
    const start = () => {
      if (started || key === null) return
      started = true
      clearTimeout(authTimeout)
      void authenticateToken(access, key)
        .then(async (p) => {
          await recordUse(deps, request, p)
          if (ended) return
          detach = deps.hub.attach(
            p.space.id,
            {
              send: () => check(),
              on: (_event, callback) => socket.on('close', callback),
              close: (code) => stop(code ?? 4001, true),
            },
            () => true,
            p.token.id
          )
          check()
        })
        .catch((error) =>
          stop(error instanceof AbeleError && error.code === 'scope_deleted' ? 4004 : 4001, true)
        )
    }
    socket.on('close', () => {
      ended = true
      detach()
      clearInterval(timer)
      clearTimeout(authTimeout)
    })
    socket.on('message', (data) => {
      if (started) return
      try {
        key = z
          .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
          .strict()
          .parse(JSON.parse(data.toString())).token
        start()
      } catch {
        stop(4001, false)
      }
    })
    start()
  })
}
