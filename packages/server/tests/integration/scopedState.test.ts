import { describe, expect, it } from 'vitest'
import { readScopedState } from '../../src/scoped/state.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `scoped connection identity (${dialect})`,
    () => {
      it('reports only the authenticated tuple, including preparing state, and refuses revoked or wrong facets', async () => {
        const f = await scopedFixture(dialect)
        try {
          const state = await readScopedState(f.deps, f.a.key_token, f.vault, f.grant.id)
          expect(state).toMatchObject({
            endpoint_identity: f.deps.endpointIdentity,
            vault_id: f.vault,
            grant_id: f.grant.id,
            principal_kind: 'key',
            principal_id: f.a.key_id,
            role: 'editor',
            state: 'preparing',
            selector: { kind: 'folder', prefix: 'Agents/' },
          })
          expect(JSON.stringify(state)).not.toMatch(/head_seq|usage|password|token_hash/)
          await expect(
            readScopedState(f.deps, f.device.deviceToken, f.vault, f.grant.id)
          ).rejects.toMatchObject({ code: 'unauthorized' })
          await f.revoke(f.a.key_id)
          await expect(
            readScopedState(f.deps, f.a.key_token, f.vault, f.grant.id)
          ).rejects.toMatchObject({ code: 'unauthorized' })
          expect(
            (await readScopedState(f.deps, f.b.key_token, f.vault, f.grant.id)).principal_id
          ).toBe(f.b.key_id)
        } finally {
          await f.close()
        }
      })
    }
  )
