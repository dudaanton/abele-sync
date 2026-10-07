import {
  CapabilitiesResponseSchema,
  AbeleError,
  ScopedHistoryPageSchema,
  ScopedTrashPageSchema,
  requireScopedCapabilities,
  SCOPED_VERSION_HEADER,
  ScopedCheckpointSchema,
  ScopedSnapshotPageSchema,
  ScopedFeedPageSchema,
  ScopedCommitRequestSchema,
  ScopedCommitResponseSchema,
  ScopedStateResponseSchema,
  ScopedManifestItemSchema,
  type ScopedCheckpoint,
  type ScopedCommitRequest,
} from '@abele/sync-protocol'
import { Http, type SendInit, type WireSchema } from './http.js'
import { z } from 'zod'
import { EngineError } from './errors.js'
import {
  scopedIdentity,
  type ScopedClientOptions,
  type ScopedConnection,
} from './scopedIdentity.js'
const segment = encodeURIComponent
export async function createScopedClient(options: ScopedClientOptions): Promise<ScopedClient> {
  return ScopedClient.create(options)
}
/** Deliberately not a VaultClient: no numeric changes, account, device or personal fallback. */
export class ScopedClient {
  readonly binding: ScopedConnection
  private readonly http: Http
  private readonly root: string
  static async create(options: ScopedClientOptions) {
    return new ScopedClient(options, await scopedIdentity(options))
  }
  private constructor(options: ScopedClientOptions, binding: ScopedConnection) {
    this.binding = binding
    this.root = `/v1/scoped/vaults/${segment(binding.vault_id)}/grants/${segment(binding.grant_id)}`
    this.http = new Http({
      ...options,
      baseUrl: binding.endpoint_identity,
      fetch: (input, init) =>
        options.fetch(input, { ...init, redirect: 'manual', cache: 'no-store' }),
    })
  }
  private async send(method: string, path: string, init: SendInit = {}) {
    const response = await this.http.send(
      method,
      path,
      {
        ...init,
        headers: { ...init.headers, [SCOPED_VERSION_HEADER]: '4', 'cache-control': 'no-store' },
      },
      [300, 301, 302, 303, 304, 305, 307, 308]
    )
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400 && response.status !== 304)
    )
      throw new EngineError('protocol', 'scoped redirect refused')
    if (
      response.url &&
      !(
        response.url === `${this.binding.endpoint_identity}${path}` ||
        response.url.startsWith(`${this.binding.endpoint_identity}${path}?`)
      )
    )
      throw new EngineError('protocol', 'scoped response issuer/path mismatch')
    return response
  }
  private async json<T>(schema: WireSchema<T>, method: string, path: string, init: SendInit = {}) {
    return this.http.decode(schema, await this.send(method, path, init), method, path)
  }
  async negotiate() {
    const capabilities = requireScopedCapabilities(
      await this.json(CapabilitiesResponseSchema, 'GET', '/v1/capabilities')
    )
    const state = await this.state()
    if (state.selector.kind === 'group' && !capabilities.modes.group)
      throw new EngineError('protocol', 'unsupported scoped selector')
    return { capabilities, state }
  }
  async state() {
    const state = await this.json(ScopedStateResponseSchema, 'GET', `${this.root}/state`)
    const binding = this.binding
    if (
      state.endpoint_identity !== binding.endpoint_identity ||
      state.vault_id !== binding.vault_id ||
      state.grant_id !== binding.grant_id ||
      state.principal_kind !== binding.principal_kind ||
      state.principal_id !== binding.principal_id
    )
      throw new EngineError(
        'protocol',
        'scoped server identity does not match the durable connection'
      )
    return state
  }
  async openSnapshot() {
    return this.json(ScopedSnapshotPageSchema, 'POST', `${this.root}/snapshots`)
  }
  async snapshotPage(snapshotId: string, cursor: string) {
    return this.json(
      ScopedSnapshotPageSchema,
      'GET',
      `${this.root}/snapshots/${segment(snapshotId)}`,
      { query: { cursor } }
    )
  }
  async feed(checkpoint: ScopedCheckpoint, limit = 1000) {
    return this.json(ScopedFeedPageSchema, 'POST', `${this.root}/feed`, {
      json: { checkpoint: ScopedCheckpointSchema.parse(checkpoint), limit },
    })
  }
  async commit(request: ScopedCommitRequest) {
    return this.json(ScopedCommitResponseSchema, 'POST', `${this.root}/commit`, {
      json: ScopedCommitRequestSchema.parse(request),
    })
  }
  async current(fileId: string) {
    const path = `${this.root}/files/${segment(fileId)}/current`,
      response = await this.send('GET', path)
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch (cause) {
      throw new EngineError('offline', 'scoped content transfer interrupted', cause)
    }
  }
  async head(fileId: string) {
    return this.json(ScopedManifestItemSchema, 'GET', `${this.root}/files/${segment(fileId)}/head`)
  }
  async version(fileId: string, versionId: string) {
    const response = await this.send(
      'GET',
      `${this.root}/files/${segment(fileId)}/versions/${segment(versionId)}`
    )
    try {
      return new Uint8Array(await response.arrayBuffer())
    } catch (cause) {
      throw new EngineError('offline', 'scoped version transfer interrupted', cause)
    }
  }
  async history(fileId: string, cursor?: string) {
    return this.json(
      ScopedHistoryPageSchema,
      'GET',
      `${this.root}/files/${segment(fileId)}/versions`,
      { query: { cursor, limit: 1000 } }
    )
  }
  async trash(cursor?: string) {
    return this.json(ScopedTrashPageSchema, 'GET', `${this.root}/trash`, {
      query: { cursor, limit: 1000 },
    })
  }
  async revokeSelf(): Promise<'revoked' | 'already'> {
    try {
      await this.json(
        z.object({ revoked: z.literal(true) }).strict(),
        'DELETE',
        `${this.root}/self`
      )
      return 'revoked'
    } catch (error) {
      if (error instanceof AbeleError && error.code === 'unauthorized') return 'already'
      throw error
    }
  }
  async putBlob(sha: string, bytes: Uint8Array) {
    const path = `${this.root}/uploads/${segment(sha)}`
    if (bytes.length <= 8 * 1024 * 1024) {
      await this.send('PUT', path, { bytes })
      return
    }
    if (bytes.length > 200 * 1024 * 1024)
      throw new EngineError('protocol', 'scoped upload bound exceeded')
    const begin = await this.json(
      z
        .object({
          upload_id: z.string().min(1).max(200),
          part_size: z
            .number()
            .int()
            .positive()
            .max(1024 * 1024),
          parts: z.number().int().positive().max(200),
          received: z.array(z.number().int().nonnegative().max(199)).max(200),
        })
        .strict(),
      'POST',
      `${path}/begin`,
      { json: { size: bytes.length } }
    )
    if (
      begin.parts !== Math.ceil(bytes.length / begin.part_size) ||
      begin.received.some((index) => index >= begin.parts)
    )
      throw new EngineError('protocol', 'invalid scoped part description')
    for (let index = 0; index < begin.parts; index++)
      if (!begin.received.includes(index))
        await this.send('PUT', `${path}/${segment(begin.upload_id)}/${index}`, {
          bytes: bytes.subarray(
            index * begin.part_size,
            Math.min(bytes.length, (index + 1) * begin.part_size)
          ),
        })
    const completed = await this.json(
      z.object({ sha: z.string(), size: z.number().int().nonnegative() }).strict(),
      'POST',
      `${path}/${segment(begin.upload_id)}/complete`
    )
    if (completed.sha !== sha || completed.size !== bytes.length)
      throw new EngineError('protocol', 'scoped completed upload mismatch')
  }
}
