import {
  createFolderGrant,
  issueFolderKey,
  updateFolderKey,
} from '../../src/auth/folderManagement.js'
import { TEST_TOKEN_PEPPER, buildTestApp } from './testApp.js'
import type { Dialect } from '../../src/db/connect.js'

export async function scopedFixture(dialect: Dialect, scopedSharing = false) {
  let clock = new Date('2030-01-01T00:00:00.000Z')
  const t = await buildTestApp({ dialect, scopedSharing, now: () => clock })
  try {
    const owner = await t.account(),
      vault = (await t.vault(owner.accountToken)).vaultId
    const device = await t.device(owner.accountToken, vault)
    const deps = {
      ...t,
      dialect,
      pepper: TEST_TOKEN_PEPPER,
      accountTokenTtlMs: 3600000,
      now: () => clock,
      endpointIdentity: 'https://synthetic.example.test',
    }
    const grant = await createFolderGrant(deps, owner.accountToken, vault, {
      label: 'Agents',
      prefix: 'Agents/',
      role: 'editor',
    })
    const issue = (name: string, role: 'reader' | 'editor' = 'editor') =>
      issueFolderKey(deps, owner.accountToken, vault, grant.id, {
        attempt_id: name,
        name,
        role,
        expires_at: '2030-01-02T00:00:00.000Z',
      })
    const a = await issue('a'),
      b = await issue('b')
    return {
      t,
      deps,
      owner,
      vault,
      device,
      grant,
      a,
      b,
      issue,
      setClock: (at: string) => {
        clock = new Date(at)
      },
      revoke: (id: string) =>
        updateFolderKey(deps, owner.accountToken, vault, grant.id, id, {
          expected_revision: 0,
          revoke: true,
        }),
      close: () => t.close(),
    }
  } catch (error) {
    await t.close()
    throw error
  }
}
