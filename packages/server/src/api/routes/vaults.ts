import {
  AbeleError,
  CommitRequestSchema,
  PrincipalSchema,
  RestoreRequestSchema,
  TrashRestoreRequestSchema,
  VaultInfoSchema,
  VaultSettingsUpdateRequestSchema,
  type Actor,
  type ChangeItem,
  type ChangesResponse,
  type CommitOpResult,
  type CommitResponse,
  type ManifestResponse,
  type TrashItem,
  type Usage,
  type VaultInfo,
  type VaultSettings,
  type VaultState,
  type VersionInfo,
} from '@abele/sync-protocol'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { z } from 'zod'
import { accountOf, authDeps, deviceOf, requireAccount, requireDevice } from '../../auth/hooks.js'
import { listTrash, restoreDeleted, restoreDeletedMany } from '../../history/trash.js'
import { topHistory, usage, type HistoryTotal } from '../../history/usage.js'
import { activity, listVersions, restoreVersion, versionBlobSha } from '../../history/versions.js'
import { changesSince, manifest } from '../../oplog/changes.js'
import { commit, type CommitDeps } from '../../oplog/commit.js'
import { Replay } from '../../oplog/keyed.js'
import { createVault, getState, listVaults, updateDeviceVaultSettings } from '../../vault/vaults.js'
import type { AppDeps } from '../app.js'
import { sendBlob } from '../blobResponse.js'
import { idempotency, keyedFor, sendReplay } from '../idempotency.js'

/** The protocol has no create-vault body of its own: a vault is made from its name. */
const CreateVaultRequestSchema = VaultInfoSchema.pick({ name: true }).extend({
  name: z.string().min(1),
})

/** A manifest page: at most 5000 files, 1000 unless asked; `cursor=` alone means the start. */
const ManifestQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
})

/** A change feed page: everything after `since`, at most 1000 items. */
const ChangesQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
})

/** An activity page: the newest items after `since`, at most 1000, 100 unless asked. */
const ActivityQuerySchema = ChangesQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})

/** A page of one file's history: at most 1000 versions, 100 unless asked; `before` is a version `no`. */
const VersionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  before: z.coerce.number().int().positive().optional(),
})

/** The trash, whole or under one folder. */
const TrashQuerySchema = z.object({ path_prefix: z.string().optional() })

/** How many of the heaviest histories `GET /usage` names. */
const TOP_FILES = 50

/** Who a device commits as. */
const actorOf = (request: FastifyRequest): Actor => {
  const device = deviceOf(request)
  return { kind: 'device', id: device.deviceId, name: device.name }
}

/** Vaults: what an account holds, and what a device's own vault is doing. */
export function registerVaultRoutes(app: FastifyInstance, deps: AppDeps): void {
  const auth = authDeps(deps)
  const account = requireAccount(auth)
  const device = requireDevice(auth)
  const idempotent = idempotency(deps)
  /** How a route that writes is registered: a client that never heard the answer may ask again. */
  const retryable = (): { preHandler: preHandlerHookHandler[]; config: { idempotent: true } } => ({
    preHandler: [device, idempotent],
    // Fresh each time: no two routes share the object Fastify keeps as their context.
    config: { idempotent: true },
  })
  /**
   * Run a retryable route's commit with its idempotency key inside it (`oplog/keyed.ts`), and
   * answer 200 with what it made — or with the first answer, when the key had one.
   */
  const keyedCommit = async <T>(
    request: FastifyRequest,
    reply: FastifyReply,
    answer: (response: CommitResponse) => T,
    run: (commitDeps: CommitDeps) => Promise<T>
  ): Promise<FastifyReply> => {
    const keyed = keyedFor(request, deps, answer)
    try {
      const device = deviceOf(request)
      const writer = PrincipalSchema.parse({
        kind: 'device',
        facet: 'device',
        principal_id: device.deviceId,
        account_id: device.accountId,
        vault_id: device.vaultId,
      })
      return reply
        .code(200)
        .send(await run({ ...deps, writer, ...(keyed === undefined ? {} : { keyed }) }))
    } catch (error) {
      if (error instanceof Replay) return sendReplay(reply, error)
      throw error
    }
  }

  app.get<{ Reply: VaultInfo[] }>('/v1/vaults', { preHandler: account }, async (request, reply) => {
    const { accountId } = accountOf(request)
    return reply.code(200).send(await listVaults(deps, accountId))
  })

  app.post<{ Reply: { id: string } }>(
    '/v1/vaults',
    { preHandler: account },
    async (request, reply) => {
      const body = CreateVaultRequestSchema.parse(request.body)
      const { accountId } = accountOf(request)
      return reply.code(201).send(await createVault(deps, accountId, body.name))
    }
  )

  app.get<{ Params: { v: string }; Reply: VaultState }>(
    '/v1/vaults/:v/state',
    { preHandler: device },
    async (request, reply) => {
      // The hook has already checked that `:v` is this device's vault.
      return reply.code(200).send(await getState(deps, deviceOf(request).vaultId))
    }
  )

  app.patch<{ Params: { v: string }; Reply: VaultSettings }>(
    '/v1/vaults/:v/settings',
    {
      preHandler: [
        device,
        app.rateLimit({
          max: 10,
          timeWindow: '1 minute',
          // After authentication and body parsing: sibling tokens cannot buy more guesses,
          // while ordinary settings patches spend none of the password-attempt budget.
          keyGenerator: (request) => deviceOf(request).accountId,
          allowList: (request) =>
            !Object.prototype.hasOwnProperty.call(request.body ?? {}, 'account_password'),
        }),
      ],
    },
    async (request, reply) => {
      const { account_password, ...patch } = VaultSettingsUpdateRequestSchema.parse(request.body)
      return reply
        .code(200)
        .send(await updateDeviceVaultSettings(deps, deviceOf(request), patch, account_password))
    }
  )

  app.get<{ Params: { v: string }; Reply: ManifestResponse }>(
    '/v1/vaults/:v/manifest',
    { preHandler: device },
    async (request, reply) => {
      const query = ManifestQuerySchema.parse(request.query)
      const cursor = query.cursor === undefined || query.cursor === '' ? null : query.cursor
      return reply
        .code(200)
        .send(await manifest(deps.db, deviceOf(request).vaultId, cursor, query.limit))
    }
  )

  app.get<{ Params: { v: string }; Reply: ChangesResponse }>(
    '/v1/vaults/:v/changes',
    { preHandler: device },
    async (request, reply) => {
      const query = ChangesQuerySchema.parse(request.query)
      return reply
        .code(200)
        .send(await changesSince(deps.db, deviceOf(request).vaultId, query.since, query.limit))
    }
  )

  app.post<{ Params: { v: string }; Reply: CommitResponse }>(
    '/v1/vaults/:v/commit',
    retryable(),
    async (request, reply) => {
      const body = CommitRequestSchema.parse(request.body)
      const { vaultId } = deviceOf(request)
      return keyedCommit(request, reply, whole, (commitDeps) =>
        commit(commitDeps, vaultId, actorOf(request), body.ops)
      )
    }
  )

  app.get<{ Params: FileParams; Reply: VersionInfo[] }>(
    '/v1/vaults/:v/files/:f/versions',
    { preHandler: device },
    async (request, reply) => {
      const query = VersionsQuerySchema.parse(request.query)
      const versions = await listVersions(deps.db, deviceOf(request).vaultId, request.params.f, {
        limit: query.limit,
        ...(query.before === undefined ? {} : { before: query.before }),
      })
      return reply.code(200).send(versions)
    }
  )

  app.get<{ Params: VersionParams }>(
    '/v1/vaults/:v/files/:f/versions/:ver',
    { preHandler: device },
    async (request, reply) => {
      const { f, ver } = request.params
      const sha = await versionBlobSha(deps.db, deviceOf(request).vaultId, f, ver)
      // A version of another file, or one that never had bytes: nothing to serve either way.
      if (sha === null) throw new AbeleError('not_found', 'no such version of that file')
      // The same bytes the blob route would hand over, ranges and all.
      return sendBlob(reply, deps.store, sha, request.headers.range)
    }
  )

  app.post<{ Params: FileParams; Reply: CommitOpResult }>(
    '/v1/vaults/:v/files/:f/restore',
    retryable(),
    async (request, reply) => {
      const { version_id } = RestoreRequestSchema.parse(request.body)
      // A restore is a commit: a refused one answers 200 with why, like every other op.
      return keyedCommit(request, reply, onlyResult, (commitDeps) =>
        restoreVersion(
          commitDeps,
          deviceOf(request).vaultId,
          actorOf(request),
          request.params.f,
          version_id
        )
      )
    }
  )

  app.get<{ Params: { v: string }; Reply: TrashItem[] }>(
    '/v1/vaults/:v/trash',
    { preHandler: device },
    async (request, reply) => {
      const query = TrashQuerySchema.parse(request.query)
      const items = await listTrash(deps.db, deviceOf(request).vaultId, query.path_prefix)
      return reply.code(200).send(items)
    }
  )

  app.post<{ Params: FileParams; Reply: CommitOpResult }>(
    '/v1/vaults/:v/trash/:f/restore',
    retryable(),
    async (request, reply) => {
      return keyedCommit(request, reply, onlyResult, (commitDeps) =>
        restoreDeleted(commitDeps, deviceOf(request).vaultId, actorOf(request), request.params.f)
      )
    }
  )

  // Registered beside `/trash/:f/restore`; Fastify tells the two apart by their segment count.
  app.post<{ Params: { v: string }; Reply: CommitResponse }>(
    '/v1/vaults/:v/trash/restore',
    retryable(),
    async (request, reply) => {
      const { file_ids } = TrashRestoreRequestSchema.parse(request.body)
      // Like a commit: an id that could not come back answers 200 with why, beside the rest.
      return keyedCommit(request, reply, whole, (commitDeps) =>
        restoreDeletedMany(commitDeps, deviceOf(request).vaultId, actorOf(request), file_ids)
      )
    }
  )

  app.get<{ Params: { v: string }; Reply: Usage & { top: HistoryTotal[] } }>(
    '/v1/vaults/:v/usage',
    { preHandler: device },
    async (request, reply) => {
      const vaultId = deviceOf(request).vaultId
      const counted = await usage(deps.db, vaultId)
      return reply
        .code(200)
        .send({ ...counted, top: await topHistory(deps.db, vaultId, TOP_FILES) })
    }
  )

  app.get<{ Params: { v: string }; Reply: ChangeItem[] }>(
    '/v1/vaults/:v/activity',
    { preHandler: device },
    async (request, reply) => {
      const query = ActivityQuerySchema.parse(request.query)
      const items = await activity(deps.db, deviceOf(request).vaultId, query.since, query.limit)
      return reply.code(200).send(items)
    }
  )
}

/** A commit's answer as the route sends it: whole. */
const whole = (response: CommitResponse): CommitResponse => response

/** A one-op commit's answer as the route sends it: its one result. */
function onlyResult(response: CommitResponse): CommitOpResult {
  const result = response.results[0]
  // One op in, one result out; anything else is the pipeline breaking its word.
  if (result === undefined) throw new Error('a restore commit answered with no result')
  return result
}

/** A route about one file of a vault. */
interface FileParams {
  v: string
  f: string
}

/** A route about one version of one file. */
interface VersionParams extends FileParams {
  ver: string
}
