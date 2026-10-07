import { z } from 'zod'
import { AbeleError } from '@abele/sync-protocol'
import type { FastifyInstance } from 'fastify'
import { authDeps, bearerOf } from '../../auth/hooks.js'
import {
  createGroupGrant,
  updateGroupGrant,
  revokeGroupMember,
} from '../../auth/groupManagement.js'
import { approveGroupRelation } from '../../auth/groupApprovals.js'
import { revokeGroupInvitation } from '../../auth/groupInvitationRevoke.js'
import {
  inviteGroupMember,
  acceptGroupInvitation,
  enrolGroupInstallation,
  discoverGroupMemberships,
} from '../../auth/groupInvitations.js'
import { prepareGroupBootstrap } from '../../scoped/groups/bootstrap.js'
import { processGroupDirtyPage } from '../../scoped/groups/worker.js'
import { authNow } from '../../auth/accounts.js'
import type { AppDeps } from '../app.js'
import { withGrantPreparation } from '../grantPreparation.js'
/** Management, preparation and group view maintenance share the deployment fence. */
export function registerGroupManagementRoutes(app: FastifyInstance, deps: AppDeps) {
  const management = {
    ...authDeps(deps),
    dialect: deps.dialect,
    store: deps.store,
    configurationDirectories: deps.config.configurationDirectories,
  }
  const prepare = async (owner: string, vault: string) => {
    const bootstrap = await prepareGroupBootstrap(management, owner, vault)
    const replay = await processGroupDirtyPage(management, vault)
    return { ...bootstrap, ...replay }
  }
  if (deps.config.scopedSharing) {
    let running: Promise<void> | undefined, after: string | undefined
    const tick = async () => {
      // Rediscover persisted, prepared vaults after restart. Both discovery and
      // each replay page are bounded; failed/expired baselines require owner review.
      let query = deps.db
        .selectFrom('scope_grants as grant')
        .innerJoin('scope_group_progress as progress', 'progress.vault_id', 'grant.vault_id')
        .select('grant.vault_id')
        .distinct()
        .where('grant.selector_kind', '=', 'group')
        .where('grant.state', 'in', ['active', 'preparing'])
        .where('grant.revoked_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('grant.expires_at', 'is', null),
            eb('grant.expires_at', '>', authNow(management).toISOString()),
          ])
        )
        .where('progress.status', '!=', 'unavailable')
        .where('progress.bootstrap_cursor', '=', 'complete')
        .orderBy('grant.vault_id')
        .limit(100)
      if (after !== undefined) query = query.where('grant.vault_id', '>', after)
      const vaults = await query.execute()
      after = vaults.length === 100 ? vaults.at(-1)!.vault_id : undefined
      for (const { vault_id } of vaults) {
        try {
          await processGroupDirtyPage(management, vault_id)
        } catch {
          app.log.error({ vaultId: vault_id }, 'scoped group view requires reviewed recovery')
        }
      }
    }
    const timer = setInterval(() => {
      if (running) return
      running = tick()
        .catch(() => app.log.error('scoped group discovery failed'))
        .finally(() => {
          running = undefined
        })
    }, 500)
    timer.unref()
    app.addHook('onClose', async () => {
      clearInterval(timer)
      await running
    })
  }
  const token = (authorization: string | undefined) => {
    const value = bearerOf(authorization)
    if (!value) throw new AbeleError('unauthorized', 'an account session is required')
    return value
  }
  app.post<{ Params: { v: string } }>('/v1/vaults/:v/grants/groups', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const owner = token(request.headers.authorization)
    const grant = await createGroupGrant(management, owner, request.params.v, request.body)
    return withGrantPreparation(grant, async () => ({
      state: (await prepare(owner, request.params.v)).ready ? 'active' : 'preparing',
    }))
  })
  app.post<{ Params: { v: string } }>(
    '/v1/vaults/:v/grants/groups/prepare',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return prepare(token(request.headers.authorization), request.params.v)
    }
  )
  app.patch<{ Params: { v: string; g: string } }>(
    '/v1/vaults/:v/grants/groups/:g',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const owner = token(request.headers.authorization)
      const grant = await updateGroupGrant(
        management,
        owner,
        request.params.v,
        request.params.g,
        request.body
      )
      if (grant.state !== 'preparing') return grant
      return withGrantPreparation(grant, async () => ({
        state: (await prepare(owner, request.params.v)).ready ? 'active' : 'preparing',
      }))
    }
  )
  app.post<{ Params: { v: string; g: string } }>(
    '/v1/vaults/:v/grants/groups/:g/approve',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return approveGroupRelation(
        management,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.body
      )
    }
  )
  app.post<{ Params: { v: string; g: string } }>(
    '/v1/vaults/:v/grants/groups/:g/invitations',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return inviteGroupMember(
        management,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.body
      )
    }
  )
  app.delete<{ Params: { v: string; g: string; m: string } }>(
    '/v1/vaults/:v/grants/groups/:g/members/:m',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const body = z
        .object({ expected_revision: z.number().int().nonnegative() })
        .strict()
        .parse(request.body)
      return revokeGroupMember(
        management,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.params.m,
        body.expected_revision
      )
    }
  )
  app.delete<{ Params: { v: string; g: string; i: string } }>(
    '/v1/vaults/:v/grants/groups/:g/invitations/:i',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return revokeGroupInvitation(
        management,
        token(request.headers.authorization),
        request.params.v,
        request.params.g,
        request.params.i
      )
    }
  )
  app.post('/v1/invitations/accept', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const body = z.object({ invitation_token: z.string() }).strict().parse(request.body)
    return acceptGroupInvitation(
      management,
      token(request.headers.authorization),
      body.invitation_token
    )
  })
  app.get('/v1/scoped/discovery', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return discoverGroupMemberships(management, token(request.headers.authorization))
  })
  app.post<{ Params: { g: string } }>(
    '/v1/scoped/grants/:g/installations',
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return enrolGroupInstallation(
        management,
        token(request.headers.authorization),
        request.params.g,
        request.body
      )
    }
  )
}
