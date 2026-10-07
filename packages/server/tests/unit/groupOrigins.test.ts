import { describe, expect, it } from 'vitest'
import { reduceGroupOrigins, type GroupWriter } from '../../src/scoped/groups/origins.js'
const owner = {
    facet: 'device' as const,
    principalId: 'device',
    accountId: 'owner',
    grantId: null,
  },
  agent = { facet: 'scoped' as const, principalId: 'agent', accountId: 'owner', grantId: 'agents' }
const token = { key: 'projects/root', targetId: null }
const version = (
  versionId: string,
  writer: GroupWriter = owner,
  extra: Record<string, unknown> = {}
) => ({
  versionId,
  writer,
  ownerAccountId: 'owner',
  operation: 'modify',
  status: 'valid',
  tokens: [token],
  ...extra,
})
describe('first introduction source reducer', () => {
  it('does not launder a limited source, but recovers after a complete direct owner empty-field baseline', () => {
    let state: ReturnType<typeof reduceGroupOrigins> | undefined
    for (let pass = 0; pass < 4; pass++)
      state = reduceGroupOrigins(
        version(`recipient-${pass}`, agent, {
          previous: state,
          tokens: Array.from({ length: 256 }, (_, index) => ({
            key: `group-${pass}-${index}`,
            targetId: null,
          })),
        })
      )
    expect(state?.limited).toBe(true)
    expect(
      reduceGroupOrigins(version('owner-preserve', owner, { previous: state })).active
    ).toEqual([])
    const cleared = reduceGroupOrigins(
      version('owner-clear', owner, { previous: state, tokens: [] })
    )
    const added = reduceGroupOrigins(version('owner-fresh-add', owner, { previous: cleared }))
    expect(added.limited).not.toBe(true)
    expect(added.memory[token.key]!.origin.kind).toBe('owner_personal')
  })
  it('never upgrades recipient/unresolved origin through owner body edits, normalization or a merge', () => {
    const introduced = reduceGroupOrigins(version('recipient', agent))
    const resaved = reduceGroupOrigins(version('owner', owner, { previous: introduced }))
    expect(resaved.memory[token.key]!.origin).toMatchObject({
      kind: 'recipient',
      versionId: 'recipient',
      grantId: 'agents',
    })
    const merged = reduceGroupOrigins(
      version('merge', owner, {
        operation: 'merge',
        sources: [introduced],
        tokens: [{ key: 'rewritten/root', targetId: 'root' }],
      })
    )
    expect(merged.memory['rewritten/root']!.origin.kind).toBe('unknown')
    const inherited = reduceGroupOrigins(
      version('merge-same', owner, { operation: 'merge', sources: [introduced] })
    )
    expect(inherited.memory[token.key]!.origin.kind).toBe('recipient')
  })
  it('retains origin through malformed YAML and requires separately proven owner removal/addition to upgrade', () => {
    const first = reduceGroupOrigins(version('recipient', agent))
    const invalid = reduceGroupOrigins(
      version('invalid', agent, { previous: first, status: 'invalid', tokens: [] })
    )
    const valid = reduceGroupOrigins(version('owner-repair', owner, { previous: invalid }))
    expect(valid.memory[token.key]!.origin.kind).toBe('recipient')
    const removed = reduceGroupOrigins(
      version('owner-removal', owner, { previous: valid, tokens: [] })
    )
    const added = reduceGroupOrigins(version('owner-add', owner, { previous: removed }))
    expect(added.memory[token.key]!.origin).toMatchObject({
      kind: 'owner_personal',
      versionId: 'owner-add',
    })
  })
  it('does not launder never-parsed recipient tokens or grant-native root edges into owner/global authority', () => {
    const invalid = reduceGroupOrigins(
      version('recipient-invalid', agent, { status: 'invalid', tokens: [] })
    )
    expect(
      reduceGroupOrigins(version('owner-repair', owner, { previous: invalid })).memory[token.key]!
        .origin.kind
    ).toBe('unknown')
    const native = reduceGroupOrigins(
      version('native', agent, {
        operation: 'create',
        nativeRoot: { key: token.key, targetId: 'root', grantId: 'agents' },
      })
    )
    expect(native.memory[token.key]!.origin).toMatchObject({
      kind: 'grant_native',
      grantId: 'agents',
    })
    expect(
      reduceGroupOrigins(version('owner-save', owner, { previous: native })).memory[token.key]!
        .origin.kind
    ).toBe('grant_native')
  })
})
