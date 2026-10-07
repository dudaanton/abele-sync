import {
  AbeleError,
  credentialFacet,
  ChangeItemSchema,
  ChangesResponseSchema,
  CommitOpResultSchema,
  CommitResponseSchema,
  DeviceInfoSchema,
  EnrolDeviceResponseSchema,
  EventFrameSchema,
  LoginResponseSchema,
  ManifestResponseSchema,
  TrashItemSchema,
  TRASH_RESTORE_MAX,
  UploadBeginResponseSchema,
  UsageSchema,
  VaultInfoSchema,
  VaultSettingsSchema,
  VaultStateSchema,
  VersionInfoSchema,
  type ChangeItem,
  type ChangesResponse,
  type CommitOp,
  type CommitOpResult,
  type CommitRequest,
  type CommitResponse,
  type DeviceInfo,
  type EnrolDeviceRequest,
  type EnrolDeviceResponse,
  type EventHello,
  type LoginResponse,
  type ManifestResponse,
  type TrashItem,
  type Usage,
  type VaultInfo,
  type VaultSettings,
  type VaultSettingsPatch,
  type VaultState,
  type VersionInfo,
} from '@abele/sync-protocol'
import { z } from 'zod'
import { EngineError } from './errors.js'
import { sha256, encodeText } from './hash.js'
import { envelopeOf, Http, idempotency, textOf, type ClientOptions } from './http.js'

export { DEFAULT_SIMPLE_UPLOAD_BYTES } from './http.js'
export type { ClientOptions } from './http.js'

/**
 * The one way the engine reaches a server. Everything here is the device facet
 * and nothing else: no retries, no queue, no state — a method is one request,
 * and what comes back is what the protocol says should come back or nothing.
 *
 * The transport is injected, so the same client runs in Obsidian, in the daemon
 * and in a test against a server in this very process. Nothing in this file
 * knows what Node is.
 */

/** What a device is: the platforms an enrolment may name. */
export type Platform = EnrolDeviceRequest['platform']

/** What every device token starts with; the server says which kind a token is by it. */
const DEVICE_TOKEN_PREFIX = 'absd_'

/** What a commit answered, and whether the server had answered it once already. */
export interface CommitOutcome {
  body: CommitResponse
  /** True when the server replayed a stored answer rather than applying the batch. */
  replayed: boolean
}

/** How much of a file's history a page of `versions` covers. */
export interface VersionsQuery {
  limit?: number
  /** Only versions numbered below this one. */
  before?: number
}

const CreatedVaultSchema = z.object({ id: z.string().min(1) })
const VaultInfoListSchema = z.array(VaultInfoSchema)
const DeviceInfoListSchema = z.array(DeviceInfoSchema)
const VersionInfoListSchema = z.array(VersionInfoSchema)
const TrashItemListSchema = z.array(TrashItemSchema)
const ChangeItemListSchema = z.array(ChangeItemSchema)
/** `GET usage` adds the heaviest histories to the usage the protocol defines. */
const UsageReportSchema = UsageSchema.extend({ top: z.array(z.unknown()) })

/**
 * A server, on one token. The account-token calls are here; everything a device
 * does to its own vault is on the `VaultClient` that `forVault` hands back.
 */
export class SyncClient {
  private readonly http: Http
  private readonly token: string

  constructor(opts: ClientOptions) {
    this.http = new Http(opts)
    this.token = opts.token
  }

  /** Trade an email and a password for an account token. Nothing is signed in yet, so no token. */
  static async login(
    baseUrl: string,
    fetchImpl: typeof fetch,
    email: string,
    password: string
  ): Promise<LoginResponse> {
    const http = new Http({ baseUrl, fetch: fetchImpl, token: '' })
    return http.json(LoginResponseSchema, 'POST', '/v1/auth/login', { json: { email, password } })
  }

  /** Enrol a device on one vault. The device token it answers with is the one every sync uses. */
  async enrolDevice(
    vaultId: string,
    name: string,
    platform: Platform
  ): Promise<EnrolDeviceResponse> {
    return this.http.json(EnrolDeviceResponseSchema, 'POST', '/v1/devices', {
      json: { vault_id: vaultId, name, platform },
    })
  }

  async listVaults(): Promise<VaultInfo[]> {
    return this.http.json(VaultInfoListSchema, 'GET', '/v1/vaults')
  }

  async createVault(name: string): Promise<{ id: string }> {
    return this.http.json(CreatedVaultSchema, 'POST', '/v1/vaults', { json: { name } })
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return this.http.json(DeviceInfoListSchema, 'GET', '/v1/devices')
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.http.send('DELETE', `/v1/devices/${segment(deviceId)}`)
  }

  /**
   * On a device token: tell the server this device is leaving, so its token stops
   * working. A token the server already refuses — revoked by this call before, or by
   * the account — reads as `already`: the device is gone either way. Only the
   * server's own refusal counts; a 401 from something in front of it is thrown, as
   * is a request that never arrived (`offline`) or a server fault.
   *
   * `already` means "this server does not take the token", which is "this device is
   * revoked" only on the server the token was minted on; the caller must know the
   * address is that one. A token that is not a device token at all — none, or an
   * account token — is never sent: the server would refuse it, and that refusal would
   * read as `already` while the real device stays live.
   */
  async revokeSelf(): Promise<'revoked' | 'already'> {
    const method = 'DELETE'
    const path = '/v1/devices/self'
    if (!this.token.startsWith(DEVICE_TOKEN_PREFIX)) {
      throw new EngineError('unauthorized', `${method} ${path} needs a device token; none is held`)
    }
    const response = await this.http.send(method, path, {}, [401])
    if (response.ok) return 'revoked'
    const raw = await textOf(response, method, path)
    const envelope = envelopeOf(raw)
    if (envelope?.code === 'unauthorized') return 'already'
    throw envelope === null
      ? new EngineError('unauthorized', `${method} ${path} was refused: the token is no good`)
      : new AbeleError(envelope.code, envelope.message, envelope.details)
  }

  /**
   * On a device token: enrol another device on this device's vault and account, and
   * hand back its token. A transfer gives it to the device it sets up, so the two
   * never share one token and either can leave without cutting off the other.
   */
  async enrolSibling(name: string, platform: Platform): Promise<EnrolDeviceResponse> {
    return this.http.json(EnrolDeviceResponseSchema, 'POST', '/v1/devices/self/siblings', {
      json: { name, platform },
    })
  }

  /** The same connection, bound to one vault: what a device token is good for. */
  forVault(vaultId: string): VaultClient {
    return new VaultClient(this.http, vaultId)
  }
}

/**
 * One vault, on a device token. Every engine piece — the puller, the pusher, the
 * uploader, the history views — talks to the server through this and nothing else.
 */
export class VaultClient {
  private readonly base: string
  async ownerPublicationIdentity() {
    if (credentialFacet(this.http.token) !== 'device')
      throw new EngineError('unauthorized', 'owner hooks need the personal device facet')
    return {
      issuer: this.http.baseUrl,
      vaultId: this.vaultId,
      credentialFingerprint: await sha256(encodeText(this.http.token)),
    }
  }

  /** Built by `SyncClient.forVault`; the transport is the client's own. */
  constructor(
    private readonly http: Http,
    readonly vaultId: string
  ) {
    this.base = `/v1/vaults/${segment(vaultId)}`
  }

  async state(): Promise<VaultState> {
    return this.http.json(VaultStateSchema, 'GET', `${this.base}/state`)
  }

  /**
   * Change some of the vault's settings, and read back all of them.
   *
   * A patch, not a replacement: what it does not name is left as it was, and `retention`
   * merges span by span. The answer is the whole settings object as the server now holds it,
   * which is what a screen showing them should redraw from — a patch that was clamped or
   * defaulted somewhere comes back saying so.
   *
   * Every retention or quota change (in either direction) requires the device account's
   * current password on this request; without it the server answers
   * `account_password_required`. Never persist the password alongside device settings.
   *
   * These are the *vault's* settings, shared by every device on it. What one device syncs is
   * its own selective settings, which live on the device and never come here.
   */
  async updateSettings(
    patch: VaultSettingsPatch,
    accountPassword?: string
  ): Promise<VaultSettings> {
    // This proof belongs to this request only; the client never keeps it for later calls.
    return this.http.json(VaultSettingsSchema, 'PATCH', `${this.base}/settings`, {
      json: accountPassword === undefined ? patch : { ...patch, account_password: accountPassword },
    })
  }

  /**
   * The live devices of this device's account on this vault, itself included, oldest
   * first. Another account sharing the vault is not listed. No token comes back: a
   * device list is for naming and cutting off, never for copying a credential.
   */
  async listVaultDevices(): Promise<DeviceInfo[]> {
    return this.http.json(DeviceInfoListSchema, 'GET', `${this.base}/devices`)
  }

  /**
   * Revoke another device of this account on this vault: its token stops working at
   * once. One revoked already answers the same, so a retry is safe. A device that is
   * not this account's on this vault throws `not_found`; this device itself throws
   * `conflict` — leaving is `SyncClient.revokeSelf`, which the caller pairs with
   * forgetting its own token.
   */
  async revokeVaultDevice(deviceId: string): Promise<void> {
    await this.http.send('DELETE', `${this.base}/devices/${segment(deviceId)}`)
  }

  /** A page of the live files in path order. `cursor` is the previous page's `next`. */
  async manifest(cursor: string | null, limit?: number): Promise<ManifestResponse> {
    return this.http.json(ManifestResponseSchema, 'GET', `${this.base}/manifest`, {
      query: { cursor, limit },
    })
  }

  /** Everything committed after `since`, oldest first. */
  async changes(since: number, limit?: number): Promise<ChangesResponse> {
    return this.http.json(ChangesResponseSchema, 'GET', `${this.base}/changes`, {
      query: { since, limit },
    })
  }

  /**
   * A batch, under a key the server files its answer against. A pusher that never
   * heard the answer sends the very same batch under the very same key: what comes
   * back is the first answer, with `replayed` saying so.
   */
  async commitRaw(ops: CommitOp[], idempotencyKey: string): Promise<CommitOutcome> {
    const path = `${this.base}/commit`
    const request: CommitRequest = { ops }
    const response = await this.http.send('POST', path, {
      json: request,
      ...idempotency(idempotencyKey),
    })
    return {
      body: await this.http.decode(CommitResponseSchema, response, 'POST', path),
      replayed: response.headers.get('idempotent-replayed') === 'true',
    }
  }

  /** The same commit, for a caller with no interest in whether it was a replay. */
  async commit(ops: CommitOp[], idempotencyKey: string): Promise<CommitResponse> {
    return (await this.commitRaw(ops, idempotencyKey)).body
  }

  /** Whether this vault can fetch those bytes. A blob no version names is not there to ask about. */
  async hasBlob(sha: string): Promise<boolean> {
    const response = await this.http.send('HEAD', `/v1/blobs/${segment(sha)}`, {}, [404])
    return response.status !== 404
  }

  async getBlob(sha: string): Promise<Uint8Array> {
    return this.http.bytes('GET', `/v1/blobs/${segment(sha)}`)
  }

  /**
   * Upload bytes under the name they hash to. Small ones go in one request;
   * anything over the simple limit is cut into the parts the server asks for and
   * sent one at a time, so a connection that drops has only the part in flight to
   * lose.
   */
  async putBlob(sha: string, bytes: Uint8Array): Promise<void> {
    const blob = `/v1/blobs/${segment(sha)}`
    if (bytes.length <= this.http.simpleUploadBytes) {
      // The answer says the sha and the size, both of which the caller passed in:
      // there is nothing in it to learn, so there is nothing in it to misread.
      await this.http.send('PUT', blob, { bytes })
      return
    }

    const upload = await this.http.json(UploadBeginResponseSchema, 'POST', `${blob}/upload`, {
      json: { size: bytes.length },
    })
    // How the file divides is arithmetic, not opinion. A server that counts the
    // parts differently would have us send the wrong bytes under the right names.
    const parts = Math.ceil(bytes.length / upload.part_size)
    if (parts !== upload.parts) {
      throw new EngineError(
        'protocol',
        `the server asked for ${upload.parts} parts of ${upload.part_size} bytes ` +
          `for ${bytes.length} bytes, which is ${parts}`
      )
    }

    const under = `${blob}/upload/${segment(upload.upload_id)}`
    const received = new Set(upload.received ?? [])
    for (let part = 0; part < parts; part++) {
      if (received.has(part)) continue
      const from = part * upload.part_size
      await this.http.send('PUT', `${under}/${part}`, {
        bytes: bytes.subarray(from, Math.min(from + upload.part_size, bytes.length)),
      })
    }
    // Again the sha and the size we already hold; the 201 is the whole answer.
    await this.http.send('POST', `${under}/complete`)
  }

  /** One file's history, newest first. */
  async versions(fileId: string, opts: VersionsQuery = {}): Promise<VersionInfo[]> {
    return this.http.json(VersionInfoListSchema, 'GET', `${this.file(fileId)}/versions`, {
      query: { limit: opts.limit, before: opts.before },
    })
  }

  /** The bytes one version of a file held. */
  async versionBytes(fileId: string, versionId: string): Promise<Uint8Array> {
    return this.http.bytes('GET', `${this.file(fileId)}/versions/${segment(versionId)}`)
  }

  /**
   * Make an old version the head again. A restore is a commit, and answers like
   * one — including the key: a restore retried under the key it was first sent
   * with is the first answer again, not a second version of the same bytes.
   */
  async restore(
    fileId: string,
    versionId: string,
    idempotencyKey?: string
  ): Promise<CommitOpResult> {
    return this.http.json(CommitOpResultSchema, 'POST', `${this.file(fileId)}/restore`, {
      json: { version_id: versionId },
      ...idempotency(idempotencyKey),
    })
  }

  /** What has been deleted and not yet swept, whole or under one folder. */
  async trash(pathPrefix?: string): Promise<TrashItem[]> {
    return this.http.json(TrashItemListSchema, 'GET', `${this.base}/trash`, {
      query: { path_prefix: pathPrefix },
    })
  }

  /** Bring a deleted file back to the path it had, under a key if it may be retried. */
  async restoreDeleted(fileId: string, idempotencyKey?: string): Promise<CommitOpResult> {
    return this.http.json(
      CommitOpResultSchema,
      'POST',
      `${this.base}/trash/${segment(fileId)}/restore`,
      idempotency(idempotencyKey)
    )
  }

  /**
   * Bring many deleted files back, each to its own path or the next free name, in commits of
   * at most `TRASH_RESTORE_MAX`: one per batch, which other devices receive as one batch of the
   * feed. One result per id, in order; a file no longer in the trash is `rejected not_found`.
   * Under a key, each batch is sent under that key and its number, so a retry of the whole call
   * is answered by what already landed instead of restoring anything twice.
   */
  async restoreDeletedMany(fileIds: string[], idempotencyKey?: string): Promise<CommitOpResult[]> {
    const results: CommitOpResult[] = []
    for (let at = 0, batch = 0; at < fileIds.length; at += TRASH_RESTORE_MAX, batch++) {
      const ids = fileIds.slice(at, at + TRASH_RESTORE_MAX)
      const key = idempotencyKey === undefined ? undefined : `${idempotencyKey}:${batch}`
      const answer = await this.http.json(
        CommitResponseSchema,
        'POST',
        `${this.base}/trash/restore`,
        {
          json: { file_ids: ids },
          ...idempotency(key),
        }
      )
      results.push(...answer.results)
    }
    return results
  }

  /** What the vault holds, with the heaviest histories named. */
  async usage(): Promise<Usage & { top: unknown[] }> {
    return this.http.json(UsageReportSchema, 'GET', `${this.base}/usage`)
  }

  /** The newest changes first, for something to show a person. */
  async activity(since?: number, limit?: number): Promise<ChangeItem[]> {
    return this.http.json(ChangeItemListSchema, 'GET', `${this.base}/activity`, {
      query: { since, limit },
    })
  }

  /**
   * Listen for the sequences this vault reaches. The socket greets the server
   * with the device token, because a WebSocket carries no headers, and from then
   * on only listens. There is no reconnecting here: the engine owns when to try
   * again, and `onClose` is how it is told to.
   */
  subscribe(onSeq: (headSeq: number) => void, onClose: (why: string) => void): () => void {
    const Socket = this.http.socketClass()
    const socket = new Socket(this.http.socketUrl(`${this.base}/events`))
    let over = false
    const finish = (why: string): void => {
      if (over) return
      over = true
      onClose(why)
    }

    socket.addEventListener('open', () => {
      const hello: EventHello = { token: this.http.token }
      socket.send(JSON.stringify(hello))
    })
    socket.addEventListener('message', (event) => {
      const frame = EventFrameSchema.safeParse(jsonOrNull(String(event.data)))
      // A frame this client does not know is a newer server talking, not a fault.
      if (frame.success && frame.data.type === 'seq') onSeq(frame.data.head_seq)
    })
    socket.addEventListener('close', (event) => {
      finish(`the server closed the stream (${event.code})`)
    })
    socket.addEventListener('error', () => {
      finish('the event stream failed')
    })

    return () => {
      // The caller hung up: it does not need telling that the socket then closed.
      over = true
      socket.close()
    }
  }

  private file(fileId: string): string {
    return `${this.base}/files/${segment(fileId)}`
  }
}

/** One path segment, safe whatever the id turns out to look like. */
const segment = (value: string): string => encodeURIComponent(value)

/** A frame's payload, or nothing: the schema below says whether it was a frame at all. */
function jsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
