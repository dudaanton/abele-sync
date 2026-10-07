import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { BlobStore } from '../../src/blobs/store.js'
import { createDb } from '../../src/db/connect.js'
import { createAccount, login } from '../../src/auth/accounts.js'
import { disableAccountWithFence, lockAccounts } from '../../src/auth/accountFence.js'
import { createFolderGrant, listOwnerGrants } from '../../src/auth/folderManagement.js'
import { withOwnerManagement } from '../../src/auth/freshOwner.js'
import { createVault } from '../../src/vault/vaults.js'
import { hasPgTestDb, tempDb } from '../helpers/tempDb.js'

const gate = () => {
  let release!: () => void
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve
    }),
    release: () => release(),
  }
}
async function fixture() {
  const t = await tempDb('pg'),
    other = createDb(t.url!)
  let clock = new Date('2030-01-01T00:00:00.000Z')
  const deps = {
    db: t.db,
    dialect: 'pg' as const,
    pepper: 'test',
    accountTokenTtlMs: 3600000,
    now: () => clock,
    store: new BlobStore('', Buffer.from('ab'.repeat(32), 'hex')),
  }
  const owner = await createAccount(deps, 'owner@example.test', 'pw'),
    token = (await login(deps, 'owner@example.test', 'pw')).account_token
  const vault = (await createVault(deps, owner.id, 'Synthetic')).id
  return {
    t,
    other,
    deps,
    owner: owner.id,
    token,
    vault,
    setClock: (next: string) => {
      clock = new Date(next)
    },
    close: async () => {
      await other.close()
      await t.close()
    },
  }
}
async function waitForAccountWaiter(db: Awaited<ReturnType<typeof fixture>>['t']['db']) {
  for (let i = 0; i < 100; i++) {
    const result =
      await sql`select 1 from pg_locks where locktype = 'advisory' and classid = 41 and not granted
      and pid in (select pid from pg_stat_activity where datname = current_database())`.execute(db)
    if (result.rows.length) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('expected an independent pool waiting on the account fence')
}

describe.skipIf(!hasPgTestDb)('folder owner fencing across independent PostgreSQL pools', () => {
  it('serializes the last available grant slot across two pools', async () => {
    const f = await fixture()
    try {
      await f.t.db
        .insertInto('scope_grants')
        .values(
          Array.from({ length: 63 }, (_, i) => ({
            id: `existing-${i}`,
            vault_id: f.vault,
            owner_account_id: f.owner,
            label: `Existing-${i}`,
            selector_kind: 'folder' as const,
            folder_prefix: `Existing-${i}/`,
            root_file_id: null,
            role: 'editor' as const,
            created_at: '2030-01-01T00:00:00.000Z',
            expires_at: null,
            revoked_at: null,
            created_session_hash: null,
            authenticated_at: null,
          }))
        )
        .execute()
      const responses = await Promise.allSettled([
        createFolderGrant(f.deps, f.token, f.vault, {
          label: 'One',
          prefix: 'One/',
          role: 'editor',
        }),
        createFolderGrant({ ...f.deps, db: f.other.db }, f.token, f.vault, {
          label: 'Two',
          prefix: 'Two/',
          role: 'editor',
        }),
      ])
      expect(responses.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(responses.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual([
        'too_large',
      ])
      expect(await listOwnerGrants(f.deps, f.token, f.vault)).toHaveLength(64)
    } finally {
      await f.close()
    }
  })
  it('orders owner publication before an account disable already waiting on its exclusive fence', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate()
    let mutation: Promise<unknown> | undefined, disable: Promise<unknown> | undefined
    try {
      mutation = withOwnerManagement(f.deps, f.token, f.vault, async (tx) => {
        entered.release()
        await release.promise
        await tx
          .updateTable('vaults')
          .set({ name: 'Published before disable' })
          .where('id', '=', f.vault)
          .execute()
      })
      await entered.promise
      disable = disableAccountWithFence(
        { ...f.deps, db: f.other.db },
        f.owner,
        '2030-01-01T00:00:01.000Z'
      )
      await waitForAccountWaiter(f.t.db)
      release.release()
      await mutation
      await disable
      expect(
        (
          await f.t.db
            .selectFrom('vaults')
            .select('name')
            .where('id', '=', f.vault)
            .executeTakeFirstOrThrow()
        ).name
      ).toBe('Published before disable')
      await expect(listOwnerGrants(f.deps, f.token, f.vault)).rejects.toMatchObject({
        code: 'unauthorized',
      })
    } finally {
      release.release()
      await Promise.allSettled([mutation, disable].filter(Boolean))
      await f.close()
    }
  })
  it('rechecks password freshness after waiting for an account fence, before creating authority', async () => {
    const f = await fixture(),
      entered = gate(),
      release = gate()
    let blocker: Promise<unknown> | undefined, mutation: Promise<unknown> | undefined
    try {
      blocker = f.other.db.transaction().execute(async (tx) => {
        await lockAccounts(tx, [f.owner], true)
        entered.release()
        await release.promise
      })
      await entered.promise
      mutation = createFolderGrant(f.deps, f.token, f.vault, {
        label: 'Too late',
        prefix: 'Agents/',
        role: 'editor',
      })
      const result = mutation.then(
        () => ({ code: 'unexpected' }),
        (error) => error
      )
      await waitForAccountWaiter(f.t.db)
      f.setClock('2030-01-01T00:05:00.000Z')
      release.release()
      await blocker
      expect(await result).toMatchObject({ code: 'unauthorized' })
      expect(await f.t.db.selectFrom('scope_grants').selectAll().execute()).toEqual([])
    } finally {
      release.release()
      await Promise.allSettled([blocker, mutation].filter(Boolean))
      await f.close()
    }
  })
})
