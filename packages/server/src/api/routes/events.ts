import {
  AbeleError,
  EventHelloSchema,
  type EventFrame,
  type EventHello,
} from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authenticateDevice, deviceIsLive } from '../../auth/devices.js'
import { authDeps } from '../../auth/hooks.js'
import type { AppDeps } from '../app.js'
import { toAbeleError } from '../errors.js'

/** Devices are told about sequences; scope epochs are not theirs to hear. */
const seqOnly = (frame: EventFrame): boolean => frame.type === 'seq'

/**
 * What every refused handshake closes with. One code for all of them: a stranger
 * learns that the socket is not theirs, and nothing about why.
 */
export const REFUSED = 4001

/** The hello, or a refusal: a frame that is not one tells the client no more than that. */
function helloOf(raw: string): EventHello {
  try {
    return EventHelloSchema.parse(JSON.parse(raw))
  } catch {
    throw new AbeleError('invalid_request', 'the first frame must be a hello')
  }
}

/**
 * The event stream. A device connects, greets the server with its token inside
 * the hello timeout, and from then on only listens: the frames say that the
 * vault has moved, and the device asks the changes feed what moved.
 */
export function registerEventRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = authDeps(deps)
  // Fastify's implicit HEAD dispatch is not a WebSocket upgrade: never pass
  // an HTTP request/reply pair to the socket hello handler.
  app.head('/v1/vaults/:v/events', async () => {
    throw new AbeleError('not_found', 'no such route')
  })

  // No `preHandler` here on purpose: the credential arrives in the hello frame,
  // not in a header, because a browser cannot set one on a WebSocket.
  app.get<{ Params: { v: string } }>(
    '/v1/vaults/:v/events',
    { websocket: true, exposeHeadRoute: false },
    (socket, request) => {
      const vaultId = request.params.v
      let greeted = false
      let refused = false

      /**
       * Refuse the socket. The client is told the code and nothing else, and the
       * frame it sent is never logged: it held a token. Only a fault of our own
       * is worth a line, and everything a client can do wrong has a code of its own.
       */
      const refuse = (error?: unknown): void => {
        refused = true
        if (error !== undefined && toAbeleError(error).code === 'internal') {
          console.error(`the event handshake on vault ${vaultId} failed:`, error)
        }
        socket.close(REFUSED)
      }

      const silence = setTimeout(() => refuse(), deps.config.wsHelloTimeoutMs)
      silence.unref?.()
      socket.on('close', () => {
        clearTimeout(silence)
      })

      const greet = async (raw: string): Promise<void> => {
        const device = await authenticateDevice(auth, helloOf(raw).token)
        // The deadline ran out while the database was being asked: that socket
        // is already closed, and what the answer turned out to be is no longer
        // anybody's business.
        if (refused) return
        // Only now: the hello is not said until the token behind it is known good.
        clearTimeout(silence)
        // A device of another vault is a stranger here, however good its token.
        if (device.vaultId !== vaultId) {
          throw new AbeleError('forbidden', 'that device belongs to another vault')
        }
        // The handshake took a database call; the client may be gone by now.
        if (socket.readyState !== socket.OPEN) return
        deps.hub.attach(vaultId, socket, seqOnly, device.deviceId)
        // A revoke that landed while the token was being checked hung up before this socket was
        // attached, and so missed it. Asked once more now that it is.
        if (!(await deviceIsLive(auth, device.deviceId))) deps.hub.hangUp(device.deviceId, REFUSED)
      }

      socket.on('message', (data) => {
        // The hello is the only thing a client ever says; the rest is ignored.
        if (greeted) return
        greeted = true
        void greet(String(data)).catch(refuse)
      })
    }
  )
}
