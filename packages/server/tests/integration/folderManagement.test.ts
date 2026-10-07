import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { login, resetPassword } from '../../src/auth/accounts.js'
import * as hashing from '../../src/auth/hash.js'
import { hashToken } from '../../src/auth/hash.js'
import {
  createFolderGrant,
  issueFolderKey,
  listFolderKeys,
  listOwnerGrants,
  updateFolderGrant,
  updateFolderKey,
} from '../../src/auth/folderManagement.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, TEST_PASSWORD, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`folder owner management (${dialect})`, () => {
    let t: TestApp,
      clock: Date,
      accountId: string,
      token: string,
      deviceToken: string,
      vault: string
    const deps = () => ({
      db: t.db,
      dialect,
      pepper: TEST_TOKEN_PEPPER,
      accountTokenTtlMs: 3600000,
      store: t.store,
      now: () => clock,
    })
    const grant = (prefix = 'Agents/') =>
      createFolderGrant(deps(), token, vault, { label: 'Agent', prefix, role: 'editor' })
    const key = (id: string, attempt = 'attempt') =>
      issueFolderKey(deps(), token, vault, id, {
        attempt_id: attempt,
        name: 'Agent',
        role: 'editor',
        expires_at: '2030-01-01T01:00:00.000Z',
      })
    beforeEach(async () => {
      clock = new Date('2030-01-01T00:00:00.000Z')
      t = await buildTestApp({ dialect, now: () => clock })
      ;({ accountId, accountToken: token } = await t.account())
      vault = (await t.vault(token)).vaultId
      deviceToken = (await t.device(token, vault)).deviceToken
    })
    afterEach(async () => {
      vi.restoreAllMocks()
      await t.close()
    })

    it('creates a folder/key without group-index state and never creates unrestricted membership', async () => {
      await sql`drop table scope_group_progress`.execute(t.db)
      const membersBefore = await t.db.selectFrom('vault_members').selectAll().execute()
      const g = await grant()
      const issued = await key(g.id)
      expect(g).toMatchObject({
        folder_prefix: 'Agents/',
        selector_kind: 'folder',
        state: 'preparing',
        role: 'editor',
      })
      expect(issued.key_token).toMatch(/^absk_[A-Za-z0-9_-]{43}$/)
      const stored = await t.db
        .selectFrom('scope_keys')
        .selectAll()
        .where('id', '=', issued.key_id)
        .executeTakeFirstOrThrow()
      expect(stored.token_hash).toBe(hashToken(TEST_TOKEN_PEPPER, issued.key_token))
      expect(await t.db.selectFrom('vault_members').selectAll().execute()).toEqual(membersBefore)
      expect(await t.db.selectFrom('account_authority').selectAll().execute()).toEqual([
        { account_id: accountId, revision: 0 },
      ])
    })
    it('refuses device/scoped/foreign-owner management, even for an owner-role vault member', async () => {
      const foreign = await t.account()
      await t.db
        .insertInto('vault_members')
        .values({ vault_id: vault, account_id: foreign.accountId, role: 'owner' })
        .execute()
      const g = await grant(),
        issued = await key(g.id)
      for (const credential of [deviceToken, issued.key_token, foreign.accountToken]) {
        await expect(
          createFolderGrant(deps(), credential, vault, {
            label: 'No',
            prefix: 'Other/',
            role: 'editor',
          })
        ).rejects.toBeDefined()
        await expect(listFolderKeys(deps(), credential, vault, g.id)).rejects.toBeDefined()
      }
    })
    it('refuses stale, unknown-time, future-time, expired, reset and disabled owner sessions', async () => {
      const hash = hashToken(TEST_TOKEN_PEPPER, token)
      for (const issued_at of [null, '2029-12-31T23:54:59.000Z', '2030-01-01T00:00:01.000Z']) {
        await t.db
          .updateTable('account_tokens')
          .set({ issued_at })
          .where('token_hash', '=', hash)
          .execute()
        await expect(grant()).rejects.toMatchObject({ code: 'unauthorized' })
      }
      await t.db
        .updateTable('account_tokens')
        .set({ issued_at: clock.toISOString(), expires_at: clock.toISOString() })
        .where('token_hash', '=', hash)
        .execute()
      await expect(grant()).rejects.toMatchObject({ code: 'unauthorized' })
      await resetPassword(
        deps(),
        (
          await t.db
            .selectFrom('accounts')
            .select('email')
            .where('id', '=', accountId)
            .executeTakeFirstOrThrow()
        ).email,
        TEST_PASSWORD
      )
      await expect(grant()).rejects.toMatchObject({ code: 'unauthorized' })
      token = (
        await login(
          deps(),
          (
            await t.db
              .selectFrom('accounts')
              .select('email')
              .where('id', '=', accountId)
              .executeTakeFirstOrThrow()
          ).email,
          TEST_PASSWORD
        )
      ).account_token
      await t.db
        .updateTable('accounts')
        .set({ disabled_at: clock.toISOString() })
        .where('id', '=', accountId)
        .execute()
      await expect(grant()).rejects.toMatchObject({ code: 'unauthorized' })
    })
    it('does not mint a fresh session from password verification that raced a password reset', async () => {
      const email = (
        await t.db
          .selectFrom('accounts')
          .select('email')
          .where('id', '=', accountId)
          .executeTakeFirstOrThrow()
      ).email
      const verify = hashing.verifyPassword
      vi.spyOn(hashing, 'verifyPassword').mockImplementation(async (password, stored) => {
        const result = await verify(password, stored)
        await resetPassword(deps(), email, 'replacement-password')
        return result
      })
      await expect(login(deps(), email, TEST_PASSWORD)).rejects.toMatchObject({
        code: 'unauthorized',
      })
      expect(await t.db.selectFrom('account_tokens').selectAll().execute()).toEqual([])
    })
    it('validates canonical folder scope and denies broad or group policy fields', async () => {
      for (const prefix of ['Agents', '../Agents/', '/Agents/', '.obsidian/', 'Agents\\', '']) {
        await expect(
          createFolderGrant(deps(), token, vault, { label: 'No', prefix, role: 'editor' })
        ).rejects.toBeDefined()
      }
      await expect(
        createFolderGrant(deps(), token, vault, {
          label: 'No',
          prefix: 'Agents/',
          role: 'editor',
          root_file_id: 'private',
        })
      ).rejects.toMatchObject({ code: 'invalid_request' })
      expect(await listOwnerGrants(deps(), token, vault)).toEqual([])
    })
    it('recovers the same encrypted issuance and refuses changed or retired attempts without minting another key', async () => {
      const g = await grant(),
        issued = await key(g.id)
      expect(await key(g.id)).toEqual(issued)
      const rows = await t.db.selectFrom('scope_key_issuances').selectAll().execute()
      expect(JSON.stringify(rows)).not.toContain(issued.key_token)
      expect(JSON.stringify(await listFolderKeys(deps(), token, vault, g.id))).not.toMatch(
        /token_hash|protected_token|absk_/
      )
      await expect(
        issueFolderKey(deps(), token, vault, g.id, {
          attempt_id: 'attempt',
          name: 'Changed',
          role: 'editor',
          expires_at: '2030-01-01T01:00:00.000Z',
        })
      ).rejects.toMatchObject({ code: 'idempotency_mismatch' })
      await updateFolderKey(deps(), token, vault, g.id, issued.key_id, {
        expected_revision: 0,
        revoke: true,
      })
      await expect(key(g.id)).rejects.toMatchObject({ code: 'conflict' })
      expect(await t.db.selectFrom('scope_keys').selectAll().execute()).toHaveLength(1)
      expect(JSON.stringify(await t.db.selectFrom('audit').selectAll().execute())).not.toContain(
        issued.key_token
      )
    })
    it('does not remint an expired recovery attempt after a new password login', async () => {
      const g = await grant(),
        issued = await key(g.id)
      clock = new Date('2030-01-01T00:10:00.000Z')
      const email = (
        await t.db
          .selectFrom('accounts')
          .select('email')
          .where('id', '=', accountId)
          .executeTakeFirstOrThrow()
      ).email
      token = (await login(deps(), email, TEST_PASSWORD)).account_token
      await expect(key(g.id)).rejects.toMatchObject({
        code: 'conflict',
        details: { key_id: issued.key_id },
      })
      expect(await t.db.selectFrom('scope_keys').selectAll().execute()).toHaveLength(1)
    })
    it('rolls issuance and audit back when password freshness expires during sealing', async () => {
      const g = await grant(),
        seal = t.store.sealPart.bind(t.store)
      vi.spyOn(t.store, 'sealPart').mockImplementation((...args) => {
        clock = new Date('2030-01-01T00:06:00.000Z')
        return seal(...args)
      })
      await expect(key(g.id)).rejects.toMatchObject({ code: 'unauthorized' })
      expect(await t.db.selectFrom('scope_keys').selectAll().execute()).toEqual([])
      expect(await t.db.selectFrom('scope_key_issuances').selectAll().execute()).toEqual([])
      expect(
        (await t.db.selectFrom('audit').selectAll().execute()).map((r) => r.action)
      ).not.toContain('scope.key.issue')
    })
    it('uses revision CAS, refuses key roles above the grant and retires recovery on a key change', async () => {
      const g = await grant(),
        issued = await key(g.id)
      await expect(
        updateFolderGrant(deps(), token, vault, g.id, { expected_revision: 1, prefix: 'Else/' })
      ).rejects.toMatchObject({ code: 'conflict' })
      const changed = await updateFolderGrant(deps(), token, vault, g.id, {
        expected_revision: 0,
        role: 'reader',
      })
      expect(changed).toMatchObject({ acl_revision: 1, scope_revision: 1, state: 'preparing' })
      expect((await listFolderKeys(deps(), token, vault, g.id))[0]).toMatchObject({
        role: 'editor',
        effective_role: 'reader',
      })
      await expect(key(g.id, 'new')).rejects.toMatchObject({ code: 'forbidden' })
      await updateFolderKey(deps(), token, vault, g.id, issued.key_id, {
        expected_revision: 0,
        role: 'reader',
      })
      await expect(key(g.id)).rejects.toMatchObject({ code: 'forbidden' })
      expect(
        (await t.db.selectFrom('scope_key_issuances').select('protected_token').execute())[0]
          ?.protected_token
      ).toBeNull()
    })
    it('keeps live keys visible through retired churn and checks renewal against the live key ceiling', async () => {
      const g = await grant()
      await t.db
        .insertInto('scope_keys')
        .values(
          Array.from({ length: 128 }, (_, i) => ({
            id: `${i < 64 ? 'expired' : 'live'}-${i}`,
            grant_id: g.id,
            owner_account_id: accountId,
            name: `Key-${i}`,
            token_hash: `synthetic-${i}`,
            role: 'editor' as const,
            created_at: '2029-12-01T00:00:00.000Z',
            expires_at: i < 64 ? '2029-12-31T00:00:00.000Z' : '2030-01-01T01:00:00.000Z',
            revoked_at: null,
            last_seen_at: null,
          }))
        )
        .execute()
      await expect(key(g.id)).rejects.toMatchObject({ code: 'too_large' })
      await expect(
        updateFolderKey(deps(), token, vault, g.id, 'expired-0', {
          expected_revision: 0,
          expires_at: '2030-01-01T01:00:00.000Z',
        })
      ).rejects.toMatchObject({ code: 'too_large' })
      const listed = await listFolderKeys(deps(), token, vault, g.id)
      expect(listed).toHaveLength(64)
      expect(listed.every((row) => row.id.startsWith('live-'))).toBe(true)
    })
    it('reserves all live slots for live-first listings and cannot renew an expired grant at the ceiling', async () => {
      const expired = await grant('Expired/')
      await t.db
        .updateTable('scope_grants')
        .set({ expires_at: '2029-12-31T00:00:00.000Z' })
        .where('id', '=', expired.id)
        .execute()
      await t.db
        .insertInto('scope_grants')
        .values(
          Array.from({ length: 64 }, (_, i) => ({
            id: `live-${i}`,
            vault_id: vault,
            owner_account_id: accountId,
            label: `live-${i}`,
            selector_kind: 'folder' as const,
            folder_prefix: `Folder-${i}/`,
            root_file_id: null,
            role: 'editor' as const,
            created_at: clock.toISOString(),
            expires_at: null,
            revoked_at: null,
            created_session_hash: null,
            authenticated_at: null,
          }))
        )
        .execute()
      await expect(grant('More/')).rejects.toMatchObject({ code: 'too_large' })
      await expect(
        updateFolderGrant(deps(), token, vault, expired.id, {
          expected_revision: 0,
          expires_at: null,
        })
      ).rejects.toMatchObject({ code: 'too_large' })
      const listed = await listOwnerGrants(deps(), token, vault)
      expect(listed).toHaveLength(64)
      expect(listed.every((r) => r.id.startsWith('live-'))).toBe(true)
    })
  })
}
