import { expect, it } from 'vitest'
import { anchoredGroupClosure } from '../../src/scoped/groups/bindings.js'
it('propagates only through approved anchors, never a planted/native member name, with iterative cycle bounds', () => {
  const input = {
    grantId: 'project',
    rootId: 'root',
    approvedAnchors: new Set(['root', 'sub']),
    eligibleFiles: new Set(['root', 'sub', 'member', 'planted', 'private', 'native']),
    edges: [
      { source: 'sub', target: 'root', kind: 'owner_personal', originGrant: null },
      { source: 'member', target: 'sub', kind: 'owner_personal', originGrant: null },
      { source: 'planted', target: 'root', kind: 'owner_personal', originGrant: null },
      { source: 'private', target: 'planted', kind: 'owner_personal', originGrant: null },
      { source: 'native', target: 'root', kind: 'grant_native', originGrant: 'other' },
      { source: 'root', target: 'sub', kind: 'owner_personal', originGrant: null },
    ],
  }
  expect([...anchoredGroupClosure(input)].sort()).toEqual(['member', 'planted', 'root', 'sub'])
})
