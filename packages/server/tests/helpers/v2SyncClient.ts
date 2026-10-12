import { createHash, randomUUID } from 'node:crypto'
import {
  decodeAccessToken,
  V2ManifestSchema,
  V2ChangesSchema,
  V2CommitResponseSchema,
  V2IssueTokenResponseSchema,
  type V2CommitOp,
} from '@abele/sync-protocol'

/** Network-only server facet driver. No account/device/scoped translation. */
export class V2SyncClient {
  readonly address: string
  readonly key: string
  constructor(
    encoded: string,
    private readonly transport: typeof fetch = fetch
  ) {
    const token = decodeAccessToken(encoded)
    this.address = token.address
    this.key = token.key
  }
  async request(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {}
  ) {
    return this.transport(this.address + '/v2' + path, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        connection: 'close',
        ...(body === undefined
          ? {}
          : {
              'content-type': Buffer.isBuffer(body)
                ? 'application/octet-stream'
                : 'application/json',
            }),
        ...headers,
      },
      ...(body === undefined
        ? {}
        : { body: Buffer.isBuffer(body) ? new Uint8Array(body).buffer : JSON.stringify(body) }),
    })
  }
  async json(path: string, method = 'GET', body?: unknown, headers?: Record<string, string>) {
    const response = await this.request(path, method, body, headers)
    const data = await response.json()
    if (!response.ok)
      throw Object.assign(new Error(JSON.stringify(data)), {
        status: response.status,
        ...data.error,
      })
    return data
  }
  async commit(ops: V2CommitOp[], key?: string) {
    return V2CommitResponseSchema.parse(
      await this.json('/commit', 'POST', { ops }, { 'idempotency-key': key ?? randomUUID() })
    )
  }
  async manifest(query = '') {
    return V2ManifestSchema.parse(await this.json('/manifest' + query))
  }
  async changes(since = 0, query = '') {
    return V2ChangesSchema.parse(await this.json(`/changes?since=${since}${query}`))
  }
  async upload(bytes: Buffer) {
    const sha = createHash('sha256').update(bytes).digest('hex')
    await this.json('/uploads/' + sha, 'PUT', bytes)
    return { sha, size: bytes.length }
  }
  async create(path: string, content: string | Buffer, mtime = 1000) {
    const blob = await this.upload(Buffer.isBuffer(content) ? content : Buffer.from(content))
    return (await this.commit([{ op: 'create', path, ...blob, mtime }])).results[0]!
  }
  async share(id: string) {
    return V2IssueTokenResponseSchema.parse(
      await this.json('/tokens', 'POST', { scope: { kind: 'folder', id }, label: 'Shared' })
    )
  }
  async content(id: string, version?: string) {
    const response = await this.request(
      `/files/${id}/content${version ? '?version_id=' + version : ''}`
    )
    if (!response.ok)
      throw Object.assign(new Error(await response.text()), { status: response.status })
    return Buffer.from(await response.arrayBuffer())
  }
}
