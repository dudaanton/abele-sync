import { VaultInfoSchema, VaultStateSchema } from '@abele/sync-protocol'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { api } from '../helpers/client.js'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'

describe('vault routes', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await buildTestApp()
  })
  afterAll(async () => {
    await t.close()
  })

  it('answers the shapes the protocol promises', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken, 'Shapes')
    const { deviceToken } = await t.device(accountToken, vaultId)

    const vaults = VaultInfoSchema.array().parse(
      (await api(t.app, accountToken).get('/v1/vaults')).body
    )
    expect(vaults).toEqual([
      expect.objectContaining({
        id: vaultId,
        usage: { live_bytes: 0, history_bytes: 0, trash_bytes: 0, quota_bytes: null, by_kind: {} },
      }),
    ])
    const state = VaultStateSchema.parse(
      (await api(t.app, deviceToken).get(`/v1/vaults/${vaultId}/state`)).body
    )
    expect(state.usage).toEqual(vaults[0]?.usage)
  })

  it('merges a retention patch span by span, over values that are not the defaults', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const client = api(t.app, deviceToken)

    const first = await client.patch(`/v1/vaults/${vaultId}/settings`, {
      retention: { attachments_days: 90 },
      account_password: TEST_PASSWORD,
    })
    expect(first.status).toBe(200)
    expect(first.body.retention).toEqual({
      notes_days: 365,
      attachments_days: 90,
      settings_days: 30,
    })

    // The span the first patch set must survive a patch that does not mention it.
    const second = await client.patch(`/v1/vaults/${vaultId}/settings`, {
      retention: { notes_days: 7 },
      account_password: TEST_PASSWORD,
    })
    expect(second.status).toBe(200)
    expect(second.body.retention).toEqual({
      notes_days: 7,
      attachments_days: 90,
      settings_days: 30,
    })

    // An empty retention patch changes nothing at all.
    const empty = await client.patch(`/v1/vaults/${vaultId}/settings`, { retention: {} })
    expect(empty.body.retention).toEqual({ notes_days: 7, attachments_days: 90, settings_days: 30 })

    // A patch of another field leaves retention alone, and it all settles in the database.
    await client.patch(`/v1/vaults/${vaultId}/settings`, {
      quota_bytes: 1024,
      account_password: TEST_PASSWORD,
    })
    const state = await client.get(`/v1/vaults/${vaultId}/state`)
    expect(state.body.settings.retention).toEqual({
      notes_days: 7,
      attachments_days: 90,
      settings_days: 30,
    })
    expect(state.body.settings.quota_bytes).toBe(1024)
    expect(state.body.usage.quota_bytes).toBe(1024)
  })

  it('refuses a vault with no name', async () => {
    const { accountToken } = await t.account()
    const r = await api(t.app, accountToken).post('/v1/vaults', { name: '' })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_request')
  })

  it('refuses a settings patch the schema does not allow', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const r = await api(t.app, deviceToken).patch(`/v1/vaults/${vaultId}/settings`, {
      conflict: 'whatever',
    })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('invalid_request')
  })

  it('lists a vault the account belongs to but does not own as a member', async () => {
    const owner = await t.account()
    const guest = await t.account()
    const { vaultId } = await t.vault(owner.accountToken, 'Shared')
    // Seed this independent membership directly in the fixture.
    await t.db
      .insertInto('vault_members')
      .values({ vault_id: vaultId, account_id: guest.accountId, role: 'member' })
      .execute()

    const mine = await api(t.app, owner.accountToken).get('/v1/vaults')
    expect(mine.body).toEqual([expect.objectContaining({ id: vaultId, role: 'owner' })])
    const theirs = await api(t.app, guest.accountToken).get('/v1/vaults')
    expect(theirs.body).toEqual([
      expect.objectContaining({ id: vaultId, name: 'Shared', role: 'member' }),
    ])
  })
})
