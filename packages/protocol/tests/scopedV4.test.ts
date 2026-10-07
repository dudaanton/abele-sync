import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  SCOPED_PROTOCOL_VERSION,
  SCOPED_LIMITS,
  SCOPED_REQUIRED_CAPABILITIES,
  CapabilitiesResponseSchema,
  PrincipalSchema,
  ScopedCheckpointSchema,
  ScopedGrantSelectorSchema,
  requireScopedCapabilities,
} from '../src/index.js'

const enabled = () => ({
  protocol_version: 1,
  device: true,
  scoped: {
    enabled: true,
    protocol_version: SCOPED_PROTOCOL_VERSION,
    modes: { folder: true, group: false },
    features: Object.fromEntries(SCOPED_REQUIRED_CAPABILITIES.map((name) => [name, true])),
    limits: { ...SCOPED_LIMITS },
  },
})

describe('lean v4 scoped contract', () => {
  it('keeps personal v1 and rejects disabled, missing, old and partial scoped capabilities', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(SCOPED_PROTOCOL_VERSION).toBe(4)
    expect(requireScopedCapabilities(enabled()).protocol_version).toBe(4)
    for (const response of [
      {},
      { protocol_version: 1, device: true, scoped: { enabled: false } },
      { ...enabled(), scoped: { ...enabled().scoped, protocol_version: 1 } },
      { ...enabled(), scoped: { ...enabled().scoped, features: {} } },
    ])
      expect(() => requireScopedCapabilities(response)).toThrow()
  })
  it('never silently strips obsolete services or advertises unimplemented v3 limits', () => {
    expect(SCOPED_LIMITS).toMatchObject({
      max_operations: 32,
      max_prepared_note_bytes: 8 * 1024 * 1024,
      max_page_items: 1000,
      max_snapshots: 2,
      snapshot_lifetime_seconds: 300,
      max_live_grants: 64,
    })
    const old = [
      'observation_dispositions',
      'atomic_units',
      'dependency_edges',
      'staged_transactions',
      'websocket',
    ]
    for (const feature of old) {
      expect(SCOPED_REQUIRED_CAPABILITIES).not.toContain(feature)
      const response = enabled()
      Object.assign(response.scoped.features, { [feature]: true })
      expect(CapabilitiesResponseSchema.safeParse(response).success).toBe(false)
    }
    const response = enabled()
    Object.assign(response.scoped.limits, { max_operations: 1000, max_dependency_edges: 10000 })
    expect(CapabilitiesResponseSchema.safeParse(response).success).toBe(false)
  })
  it('requires disjoint account/device/scoped facets, even for the same owner account', () => {
    const key = {
      kind: 'key',
      facet: 'scoped',
      principal_id: 'key',
      account_id: 'owner',
      vault_id: 'vault',
      grant_id: 'grant',
    }
    expect(PrincipalSchema.parse(key).facet).toBe('scoped')
    expect(PrincipalSchema.safeParse({ ...key, facet: 'device' }).success).toBe(false)
    expect(PrincipalSchema.safeParse({ ...key, kind: 'device' }).success).toBe(false)
    expect(PrincipalSchema.safeParse({ ...key, grant_id: undefined }).success).toBe(false)
  })
  it('tags opaque scoped checkpoints rather than accepting personal sequence numbers', () => {
    expect(ScopedCheckpointSchema.parse({ kind: 'scoped', token: 'opaque-progress' }).token).toBe(
      'opaque-progress'
    )
    for (const value of [
      7,
      '7',
      { kind: 'scoped', token: 7 },
      { kind: 'personal', token: '7' },
      { kind: 'scoped', token: 'x', seq: 7 },
    ]) {
      expect(ScopedCheckpointSchema.safeParse(value).success).toBe(false)
    }
  })
  it('allows exactly one canonical folder or stable group identity, never a remap or glob', () => {
    expect(ScopedGrantSelectorSchema.parse({ kind: 'folder', prefix: 'Agents/' })).toEqual({
      kind: 'folder',
      prefix: 'Agents/',
    })
    expect(ScopedGrantSelectorSchema.parse({ kind: 'group', root_file_id: 'books-id' })).toEqual({
      kind: 'group',
      root_file_id: 'books-id',
    })
    for (const value of [
      { kind: 'folder', prefix: '' },
      { kind: 'folder', prefix: '/' },
      { kind: 'folder', prefix: '../Agents/' },
      { kind: 'folder', prefix: 'Agents\\' },
      { kind: 'folder', prefix: 'Agents/', mount_path: 'Shared/' },
      { kind: 'folder', prefix: 'Agents/', root_file_id: 'books-id' },
      { kind: 'glob', pattern: '**/*.md' },
    ])
      expect(ScopedGrantSelectorSchema.safeParse(value).success).toBe(false)
  })
})
