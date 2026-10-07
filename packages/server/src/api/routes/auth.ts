import {
  EnrolDeviceRequestSchema,
  EnrolSiblingRequestSchema,
  LoginRequestSchema,
  type DeviceInfo,
  type EnrolDeviceResponse,
  type LoginResponse,
} from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { login } from '../../auth/accounts.js'
import {
  enrolDevice,
  enrolSibling,
  listDevices,
  listVaultDevices,
  revokeDevice,
  revokeSelf,
  revokeVaultDevice,
} from '../../auth/devices.js'
import { hashToken } from '../../auth/hash.js'
import { dropUploadsOf } from '../../blobs/pending.js'
import { createUploadManager } from '../../blobs/uploads.js'
import {
  accountOf,
  authDeps,
  bearerOf,
  deviceOf,
  requireAccount,
  requireAnyDevice,
  requireDevice,
} from '../../auth/hooks.js'
import type { AppDeps } from '../app.js'
import { REFUSED } from './events.js'

/** Logging in, and the devices an account has enrolled. */
export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = authDeps(deps)
  const account = requireAccount(auth)
  const device = requireAnyDevice(auth)
  const vaultDevice = requireDevice(auth)
  /** A revoked device's uploads nobody committed go with it: nobody is left to commit them. */
  const uploads = createUploadManager(deps)
  const dropUploads = (deviceId: string): Promise<number> =>
    dropUploadsOf(
      { db: deps.db, store: deps.store, now: deps.now ?? (() => new Date()), uploads },
      deviceId
    )
  /**
   * A rate limit counted per token rather than per address: what is being limited is
   * what one credential can do, wherever it is used from. The key is the token as the
   * auth hook reads it, so no spelling of the header buys a fresh count, and it is
   * hashed, so the limiter's table holds no token in the clear.
   */
  const perToken = (max: number) => ({
    rateLimit: {
      max,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => {
        const token = bearerOf(request.headers.authorization)
        return token === null || token === ''
          ? request.ip
          : `token:${hashToken(deps.config.tokenPepper, token)}`
      },
    },
  })

  app.post<{ Reply: LoginResponse }>(
    '/v1/auth/login',
    // Guessing passwords is the one thing worth throttling at the door.
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = LoginRequestSchema.parse(request.body)
      return reply.code(200).send(await login(auth, body.email, body.password))
    }
  )

  app.post<{ Reply: EnrolDeviceResponse }>(
    '/v1/devices',
    { preHandler: account },
    async (request, reply) => {
      const body = EnrolDeviceRequestSchema.parse(request.body)
      const { accountId } = accountOf(request)
      const device = await enrolDevice(auth, accountId, body.vault_id, body.name, body.platform)
      return reply.code(201).send(device)
    }
  )

  app.get<{ Reply: DeviceInfo[] }>(
    '/v1/devices',
    { preHandler: account },
    async (request, reply) => {
      const { accountId } = accountOf(request)
      return reply.code(200).send(await listDevices(auth, accountId))
    }
  )

  // The two `/self` routes take a device token and act on that device. find-my-way
  // matches a static segment before a parameter, so `/self` never reaches `/:id`,
  // which stays the account's route.
  app.delete('/v1/devices/self', { preHandler: device }, async (request, reply) => {
    const self = deviceOf(request)
    await revokeSelf(auth, self)
    await dropUploads(self.deviceId)
    // A revoked device's open event socket stops hearing the vault now, not at its next reconnect.
    deps.hub.hangUp(self.deviceId, REFUSED)
    return reply.code(204).send()
  })

  app.post<{ Reply: EnrolDeviceResponse }>(
    '/v1/devices/self/siblings',
    {
      preHandler: device,
      config: perToken(10),
    },
    async (request, reply) => {
      const body = EnrolSiblingRequestSchema.parse(request.body)
      const sibling = await enrolSibling(auth, deviceOf(request), body.name, body.platform)
      return reply.code(201).send(sibling)
    }
  )

  app.delete<{ Params: { id: string } }>(
    '/v1/devices/:id',
    { preHandler: account },
    async (request, reply) => {
      const { accountId } = accountOf(request)
      await revokeDevice(auth, accountId, request.params.id)
      await dropUploads(request.params.id)
      deps.hub.hangUp(request.params.id, REFUSED)
      return reply.code(204).send()
    }
  )

  // The vault's own devices, on a device token of that vault. Another vault in the
  // path is forbidden by the hook; another account's devices on this vault are
  // neither listed nor reachable. No token is ever in an answer.
  app.get<{ Params: { v: string }; Reply: DeviceInfo[] }>(
    '/v1/vaults/:v/devices',
    { preHandler: vaultDevice, config: perToken(60) },
    async (request, reply) => {
      return reply.code(200).send(await listVaultDevices(auth, deviceOf(request)))
    }
  )

  app.delete<{ Params: { v: string; id: string } }>(
    '/v1/vaults/:v/devices/:id',
    { preHandler: vaultDevice, config: perToken(10) },
    async (request, reply) => {
      await revokeVaultDevice(auth, deviceOf(request), request.params.id)
      await dropUploads(request.params.id)
      deps.hub.hangUp(request.params.id, REFUSED)
      return reply.code(204).send()
    }
  )
}
