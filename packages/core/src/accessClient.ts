import {
  decodeAccessToken,
  V2AccessTokenSchema,
  V2ConnectionSchema,
  V2IssueTokenRequestSchema,
  V2IssueTokenResponseSchema,
  V2TokensResponseSchema,
  V2RevokeTokenResponseSchema,
  V2TokenItemsResponseSchema,
  V2ItemContentPreviewSchema,
  V2TokenContentPreviewSchema,
  V2ContentPreviewQuerySchema,
  type V2AccessToken,
  type V2IssueTokenRequest,
} from '@abele/sync-protocol'
import { Http, type ClientOptions } from './http.js'

/** One token connection, identical for personal devices and shared access. */
export class AccessClient {
  private readonly http: Http
  readonly token: V2AccessToken
  constructor(token: V2AccessToken, transport: Omit<ClientOptions, 'baseUrl' | 'token'>) {
    this.token = V2AccessTokenSchema.parse(token)
    this.http = new Http({ ...transport, baseUrl: this.token.address, token: this.token.key })
  }
  static fromToken(
    encoded: string,
    transport: Omit<ClientOptions, 'baseUrl' | 'token'>
  ): AccessClient {
    return new AccessClient(decodeAccessToken(encoded), transport)
  }
  connection() {
    return this.http.json(V2ConnectionSchema, 'GET', '/v2/connection')
  }
  issue(request: V2IssueTokenRequest) {
    return this.http.json(V2IssueTokenResponseSchema, 'POST', '/v2/tokens', {
      json: V2IssueTokenRequestSchema.parse(request),
    })
  }
  tokens() {
    return this.http.json(V2TokensResponseSchema, 'GET', '/v2/tokens')
  }
  tokenItems(id: string) {
    return this.http.json(
      V2TokenItemsResponseSchema,
      'GET',
      `/v2/tokens/${encodeURIComponent(id)}/items`
    )
  }
  revoke(id: string) {
    return this.http.json(
      V2RevokeTokenResponseSchema,
      'DELETE',
      `/v2/tokens/${encodeURIComponent(id)}`
    )
  }
  previewTokenItem(id: string, item: string, options: { limit?: number } = {}) {
    return this.http.json(
      V2ItemContentPreviewSchema,
      'GET',
      `/v2/tokens/${encodeURIComponent(id)}/items/${encodeURIComponent(item)}/preview`,
      { query: V2ContentPreviewQuerySchema.parse(options) }
    )
  }
  previewToken(id: string, options: { limit?: number } = {}) {
    return this.http.json(
      V2TokenContentPreviewSchema,
      'GET',
      `/v2/tokens/${encodeURIComponent(id)}/preview`,
      { query: V2ContentPreviewQuerySchema.parse(options) }
    )
  }
}
