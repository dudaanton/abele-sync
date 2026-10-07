import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPassword } from '../../src/auth/accounts.js'
import { readJson } from '../../src/db/json.js'
import { getVaultSettings, updateVaultSettings } from '../../src/vault/vaults.js'
import { api } from '../helpers/client.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { buildTestApp, TEST_PASSWORD, TEST_TOKEN_PEPPER, type TestApp } from '../helpers/testApp.js'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `settings password protection (${dialect})`,
    () => {
      let t: TestApp
      let accountId: string
      let accountToken: string
      let deviceId: string
      let deviceToken: string
      let vaultId: string
      const url = () => `/v1/vaults/${vaultId}/settings`
      const patch = (body: unknown) => api(t.app, deviceToken).patch(url(), body)
      const settings = () => getVaultSettings(t, vaultId)
      const audits = () =>
        t.db.selectFrom('audit').selectAll().where('vault_id', '=', vaultId).execute()

      beforeEach(async () => {
        t = await buildTestApp({ dialect })
        ;({ accountId, accountToken } = await t.account('settings@example.test'))
        ;({ vaultId } = await t.vault(accountToken))
        ;({ deviceId, deviceToken } = await t.device(accountToken, vaultId))
      })
      afterEach(async () => {
        await t.close()
      })

      for (const field of ['notes_days', 'attachments_days', 'settings_days'] as const) {
        for (const days of [1, 0]) {
          it(`refuses a device-only decrease of ${field} to ${days}, atomically`, async () => {
            const before = await settings()
            const response = await patch({
              retention: { [field]: days },
              conflict: 'conflict-file',
            })
            expect(response.status).toBe(403)
            expect(response.body.error.code).toBe('account_password_required')
            expect(response.body.error.message).toContain('password')
            expect(await settings()).toEqual(before)
            expect(await audits()).toEqual([])
          })
        }
      }

      for (const quota of [101, null]) {
        it(`refuses a device-only quota change from 100 to ${quota}`, async () => {
          await updateVaultSettings({ ...t, dialect }, vaultId, { quota_bytes: 100 })
          const before = await settings()
          const response = await patch({ quota_bytes: quota, retention: { notes_days: 500 } })
          expect(response.status).toBe(403)
          expect(response.body.error.code).toBe('account_password_required')
          expect(await settings()).toEqual(before)
        })
      }

      for (const field of ['notes_days', 'attachments_days', 'settings_days'] as const) {
        it(`refuses a device-only increase of ${field} and accepts fresh password proof`, async () => {
          const before = await settings()
          const body = { retention: { [field]: before.retention[field] + 1 } }
          expect((await patch(body)).status).toBe(403)
          expect(await settings()).toEqual(before)
          expect(await audits()).toEqual([])
          expect((await patch({ ...body, account_password: TEST_PASSWORD })).status).toBe(200)
        })
      }

      for (const quota of [99, 0]) {
        it(`refuses a device-only quota reduction to ${quota} and accepts fresh password proof`, async () => {
          await updateVaultSettings({ ...t, dialect }, vaultId, { quota_bytes: 100 })
          const before = await settings()
          expect((await patch({ quota_bytes: quota, conflict: 'conflict-file' })).status).toBe(403)
          expect(await settings()).toEqual(before)
          expect(await audits()).toEqual([])
          expect(
            (await patch({ quota_bytes: quota, account_password: TEST_PASSWORD })).status
          ).toBe(200)
        })
      }

      it('refuses setting a quota from unlimited without fresh password proof', async () => {
        const before = await settings()
        expect(before.quota_bytes).toBeNull()
        expect((await patch({ quota_bytes: 100 })).status).toBe(403)
        expect(await settings()).toEqual(before)
        expect((await patch({ quota_bytes: 100, account_password: TEST_PASSWORD })).status).toBe(
          200
        )
      })

      it('allows only equal retention/quota values and unrelated settings without a password', async () => {
        expect((await patch({ quota_bytes: null })).status).toBe(200)
        expect((await patch({ quota_bytes: 100, account_password: TEST_PASSWORD })).status).toBe(
          200
        )
        expect((await patch({ quota_bytes: 100, retention: { notes_days: 365 } })).status).toBe(200)
        expect(
          (
            await patch({
              quota_bytes: 100,
              retention: { notes_days: 365, attachments_days: 14, settings_days: 30 },
              scripts_folder: 'Automation',
              conflict: 'conflict-file',
              max_file_bytes: 999,
              key_signature: { enabled: true, property: 'signed', value: 'yes' },
            })
          ).status
        ).toBe(200)
        expect(await settings()).toMatchObject({
          quota_bytes: 100,
          retention: { notes_days: 365, attachments_days: 14, settings_days: 30 },
        })
        expect(await audits()).toContainEqual(
          expect.objectContaining({
            actor_kind: 'device',
            actor_id: deviceId,
            action: 'vault.settings.update',
            result: 'applied',
          })
        )
      })

      it('checks against the latest values rather than the defaults', async () => {
        expect(
          (await patch({ retention: { notes_days: 500 }, account_password: TEST_PASSWORD })).status
        ).toBe(200)
        expect((await patch({ retention: { notes_days: 500 } })).status).toBe(200)
        expect((await patch({ retention: { notes_days: 400 } })).status).toBe(403)
        expect((await settings()).retention.notes_days).toBe(500)
        expect((await patch({ quota_bytes: 0, account_password: TEST_PASSWORD })).status).toBe(200)
        expect((await patch({ quota_bytes: 1 })).status).toBe(403)
      })

      it('serializes concurrent device patches so neither can weaken a setting the other just tightened', async () => {
        const responses = await Promise.all([
          patch({
            retention: { notes_days: 500 },
            quota_bytes: 100,
            account_password: TEST_PASSWORD,
          }),
          patch({ retention: { notes_days: 400 }, quota_bytes: 200 }),
        ])
        expect(responses[0]!.status).toBe(200)
        expect(responses[1]!.status).toBe(403)
        expect(await settings()).toMatchObject({ retention: { notes_days: 500 }, quota_bytes: 100 })
        expect(await audits()).toHaveLength(responses.filter((r) => r.status === 200).length)
      })

      it('rolls back the audit entry and settings together when the settings write fails', async () => {
        const before = await settings()
        if (dialect === 'sqlite') {
          await sql`create trigger reject_settings_update before update on vaults
            begin select raise(abort, 'settings write failed'); end`.execute(t.db)
        } else {
          await sql`create function reject_settings_update() returns trigger language plpgsql as
            $$ begin raise exception 'settings write failed'; end $$`.execute(t.db)
          await sql`create trigger reject_settings_update before update on vaults
            for each row execute function reject_settings_update()`.execute(t.db)
        }
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
          const response = await patch({
            retention: { notes_days: 0 },
            account_password: TEST_PASSWORD,
          })
          expect(response.status).toBe(500)
          expect(response.body.error.code).toBe('internal')
          expect(await settings()).toEqual(before)
          expect(await audits()).toEqual([])
          expect(logged).toHaveBeenCalled()
          expect(JSON.stringify(logged.mock.calls)).not.toContain(TEST_PASSWORD)
        } finally {
          logged.mockRestore()
        }
      })

      it('accepts the account password on this request, audits the change and never stores or echoes the password', async () => {
        await updateVaultSettings({ ...t, dialect }, vaultId, { quota_bytes: 100 })
        const before = await settings()
        const response = await patch({
          retention: { notes_days: 0, attachments_days: 0, settings_days: 0 },
          quota_bytes: null,
          account_password: TEST_PASSWORD,
        })
        expect(response.status).toBe(200)
        expect(response.body.retention).toEqual({
          notes_days: 0,
          attachments_days: 0,
          settings_days: 0,
        })
        expect(response.body.quota_bytes).toBeNull()
        expect(response.body).not.toHaveProperty('account_password')
        const rows = await audits()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          actor_kind: 'account',
          actor_id: accountId,
          action: 'vault.settings.update',
          result: 'applied',
          path: null,
        })
        expect(readJson(rows[0]!.details)).toEqual({
          device_id: deviceId,
          before,
          after: response.body,
        })
        const stored = await t.db
          .selectFrom('vaults')
          .select('settings')
          .where('id', '=', vaultId)
          .executeTakeFirstOrThrow()
        expect(readJson(stored.settings)).toEqual(response.body)
        expect(JSON.stringify(rows)).not.toContain(TEST_PASSWORD)
        expect(await t.db.selectFrom('account_tokens').selectAll().execute()).toHaveLength(1)
        // A successful proof never elevates the device's later requests.
        expect((await patch({ quota_bytes: 100 })).status).toBe(403)
        expect((await patch({ quota_bytes: 100, account_password: TEST_PASSWORD })).status).toBe(
          200
        )
        expect((await patch({ quota_bytes: 101 })).status).toBe(403)
        expect((await patch({ quota_bytes: 101, account_password: TEST_PASSWORD })).status).toBe(
          200
        )
      })

      it('refuses a wrong password without applying even the safe part of a patch', async () => {
        const before = await settings()
        const response = await patch({
          retention: { notes_days: 0 },
          conflict: 'conflict-file',
          account_password: 'wrong-password',
        })
        expect(response.status).toBe(401)
        expect(response.body.error.code).toBe('unauthorized')
        expect(await settings()).toEqual(before)
        expect(await audits()).toEqual([])
      })

      it('requires the password of the device account, not a different account or an old password', async () => {
        const auth = { db: t.db, pepper: TEST_TOKEN_PEPPER, accountTokenTtlMs: 60_000 }
        await resetPassword(auth, 'settings@example.test', 'replacement-password')
        // The old account session is gone but the device remains valid; password proof must be fresh.
        expect(
          (await patch({ retention: { notes_days: 0 }, account_password: TEST_PASSWORD })).status
        ).toBe(401)
        expect(
          (await patch({ retention: { notes_days: 0 }, account_password: 'replacement-password' }))
            .status
        ).toBe(200)
        const other = await t.account('other@example.test')
        expect(other.accountId).not.toBe(accountId)
        expect(
          (await patch({ quota_bytes: 0, account_password: 'replacement-password' })).status
        ).toBe(200)
        expect((await patch({ quota_bytes: null, account_password: TEST_PASSWORD })).status).toBe(
          401
        )
      })

      it('does not let a password bypass vault binding or replace the device credential', async () => {
        const other = await t.vault(accountToken)
        const body = { retention: { notes_days: 0 }, account_password: TEST_PASSWORD }
        expect(
          (await api(t.app, deviceToken).patch(`/v1/vaults/${other.vaultId}/settings`, body)).status
        ).toBe(403)
        expect((await api(t.app).patch(url(), body)).status).toBe(401)
        expect((await api(t.app, accountToken).patch(url(), body)).status).toBe(401)
      })

      it('does not accept a correct password for a revoked device or disabled account', async () => {
        const body = { retention: { notes_days: 0 }, account_password: TEST_PASSWORD }
        await t.db
          .updateTable('accounts')
          .set({ disabled_at: new Date().toISOString() })
          .where('id', '=', accountId)
          .execute()
        expect((await patch(body)).status).toBe(401)
        await t.db
          .updateTable('accounts')
          .set({ disabled_at: null })
          .where('id', '=', accountId)
          .execute()
        await t.db
          .updateTable('devices')
          .set({ revoked_at: new Date().toISOString() })
          .where('id', '=', deviceId)
          .execute()
        expect((await patch(body)).status).toBe(401)
        expect((await settings()).retention.notes_days).toBe(365)
        expect(await audits()).toEqual([])
      })

      it('rejects malformed password proof rather than silently stripping it', async () => {
        for (const account_password of ['', null, 42]) {
          expect((await patch({ retention: { notes_days: 0 }, account_password })).status).toBe(400)
        }
      })

      it('bounds password attempts across sibling devices without throttling ordinary settings', async () => {
        const sibling = await t.device(accountToken, vaultId, 'sibling')
        for (let i = 0; i < 10; i++) {
          expect(
            (await patch({ retention: { notes_days: 0 }, account_password: 'wrong-password' }))
              .status
          ).toBe(401)
        }
        const blocked = await api(t.app, sibling.deviceToken).patch(url(), {
          retention: { notes_days: 0 },
          account_password: TEST_PASSWORD,
        })
        expect(blocked.status).toBe(429)
        expect(blocked.body.error.code).toBe('rate_limited')
        expect((await patch({ conflict: 'conflict-file' })).status).toBe(200)
        expect((await patch({ retention: { notes_days: 500 } })).status).toBe(403)
      })
    }
  )
}
