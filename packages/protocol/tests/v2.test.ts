import { describe, expect, it } from 'vitest'
import {
  decodeAccessToken,
  encodeAccessToken,
  V2AccessTokenSchema,
  V2ChangeSchema,
  V2ConnectionSchema,
  V2IssueTokenRequestSchema,
  V2ManifestSchema,
  V2CommitRequestSchema,
} from '../src/v2.js'

const token = {
  v: 1 as const,
  address: 'https://sync.example',
  key: 'a'.repeat(43),
  scope: { kind: 'folder' as const, id: 'root-id', path: '/' },
}

describe('v2 contract', () => {
  it('UTF-8 base64 JSON is exactly the QR payload; round trips Unicode hints', () => {
    const value = {
      ...token,
      scope: { kind: 'group' as const, id: 'note-id', path: 'Проекты/Группа.md' },
    }
    const encoded = encodeAccessToken(value)
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual(value)
    expect(decodeAccessToken(encoded)).toEqual(value)
  })
  it('rejects damaged, incomplete, unsafe and extended tokens with a usable reason', () => {
    for (const bad of ['???', 'e30=', Buffer.from('{"v":2}').toString('base64')]) {
      expect(() => decodeAccessToken(bad)).toThrow(/token/i)
    }
    expect(V2AccessTokenSchema.safeParse({ ...token, address: 'http://example.org' }).success).toBe(
      false
    )
    expect(V2AccessTokenSchema.safeParse({ ...token, key: 'short' }).success).toBe(false)
    expect(V2AccessTokenSchema.safeParse({ ...token, role: 'reader' }).success).toBe(false)
  })
  it('issues by stable selector only, never accepts a role or client path as authority', () => {
    expect(
      V2IssueTokenRequestSchema.parse({ scope: { kind: 'folder', id: 'folder-id' }, label: 'Mac' })
    ).toEqual({ scope: { kind: 'folder', id: 'folder-id' }, label: 'Mac' })
    expect(V2IssueTokenRequestSchema.safeParse({ scope: token.scope }).success).toBe(false)
    expect(
      V2IssueTokenRequestSchema.safeParse({ scope: { kind: 'folder', id: 'x' }, role: 'reader' })
        .success
    ).toBe(false)
  })
  it('distinguishes departure from deletion and does not disclose private destinations', () => {
    const common = { cursor: 1, file_id: 'f', path: 'Shared/a.md', at: '2026-10-10T00:00:00Z' }
    expect(V2ChangeSchema.parse({ ...common, type: 'removal' }).type).toBe('removal')
    expect(V2ChangeSchema.parse({ ...common, type: 'delete', version_id: 'v' }).type).toBe('delete')
    expect(
      V2ChangeSchema.safeParse({ ...common, type: 'removal', to_path: 'Private/a.md' }).success
    ).toBe(false)
    expect(V2ChangeSchema.safeParse({ ...common, type: 'revoked' }).success).toBe(false)
  })
  it('freezes connection, complete snapshot paging and directory commits', () => {
    expect(
      V2ConnectionSchema.parse({
        protocol: 2,
        token_id: 't',
        space_id: 's',
        scope: token.scope,
        status: 'active',
        limits: { max_file_bytes: 100, quota_bytes: null },
      }).protocol
    ).toBe(2)
    expect(V2ManifestSchema.parse({ items: [], cursor: 0, next: null }).items).toEqual([])
    expect(
      V2CommitRequestSchema.parse({ ops: [{ op: 'mkdir', path: 'Shared' }] }).ops
    ).toHaveLength(1)
  })
})
