import { AbeleError } from '@abele/sync-protocol'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import {
  createFolderGrant,
  issueFolderKey,
  listFolderKeys,
  listOwnerGrants,
  updateFolderGrant,
  updateFolderKey,
} from '../../auth/folderManagement.js'
import { prepareFolderAdmissions } from '../../scoped/admissions.js'
import type { AppDeps } from '../app.js'
import { withGrantPreparation } from '../grantPreparation.js'

const ownerToken = (request: FastifyRequest) => {
  const token = bearerOf(request.headers.authorization)
  if (!token) throw new AbeleError('unauthorized', 'a fresh owner session is required')
  return token
}
/** Owner management and bounded preparation, behind the deployment fence. */
export function registerFolderGrantRoutes(app: FastifyInstance, deps: AppDeps): void {
  const management = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    configurationDirectories: deps.config.configurationDirectories,
  }
  const base = '/v1/vaults/:v/grants'
  type Grant = { v: string; g: string }
  app.get<{ Params: { v: string } }>(base, async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send(await listOwnerGrants(management, ownerToken(request), request.params.v))
  )
  app.post<{ Params: { v: string } }>(base, async (request, reply) => {
    const token = ownerToken(request)
    const grant = await createFolderGrant(management, token, request.params.v, request.body)
    const result = await withGrantPreparation(grant, () =>
      prepareFolderAdmissions(management, token, request.params.v, grant.id)
    )
    return reply.code(201).header('Cache-Control', 'no-store').send(result)
  })
  // Large baselines continue one bounded page at a time; no lease renewal/recovery.
  app.post<{ Params: Grant }>(`${base}/:g/prepare`, async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send(
        await prepareFolderAdmissions(
          management,
          ownerToken(request),
          request.params.v,
          request.params.g
        )
      )
  )
  app.patch<{ Params: Grant }>(`${base}/:g`, async (request, reply) => {
    const token = ownerToken(request)
    const grant = await updateFolderGrant(
      management,
      token,
      request.params.v,
      request.params.g,
      request.body
    )
    const result =
      grant.state === 'preparing'
        ? await withGrantPreparation(grant, () =>
            prepareFolderAdmissions(management, token, request.params.v, grant.id)
          )
        : grant
    return reply.header('Cache-Control', 'no-store').send(result)
  })
  app.get<{ Params: Grant }>(`${base}/:g/keys`, async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send(
        await listFolderKeys(management, ownerToken(request), request.params.v, request.params.g)
      )
  )
  app.post<{ Params: Grant }>(`${base}/:g/keys`, async (request, reply) =>
    reply
      .code(201)
      .header('Cache-Control', 'no-store')
      .send(
        await issueFolderKey(
          management,
          ownerToken(request),
          request.params.v,
          request.params.g,
          request.body
        )
      )
  )
  app.patch<{ Params: Grant & { k: string } }>(`${base}/:g/keys/:k`, async (request, reply) =>
    reply
      .header('Cache-Control', 'no-store')
      .send(
        await updateFolderKey(
          management,
          ownerToken(request),
          request.params.v,
          request.params.g,
          request.params.k,
          request.body
        )
      )
  )
}
