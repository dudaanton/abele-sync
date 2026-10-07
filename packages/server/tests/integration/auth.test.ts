import { performance } from 'node:perf_hooks'
import { describe, it, expect, beforeEach } from 'vitest'
import { tempDb } from '../helpers/tempDb.js'
import {
  createAccount,
  login,
  authenticateAccount,
  resetPassword,
} from '../../src/auth/accounts.js'
import {
  enrolDevice,
  authenticateDevice,
  revokeDevice,
  listDevices,
} from '../../src/auth/devices.js'
import { createVault, isMember } from '../../src/vault/vaults.js'
import type { DeviceInfo } from '@abele/sync-protocol'

async function makeDeps() {
  const h = await tempDb()
  return { db: h.db, pepper: 'p', accountTokenTtlMs: 3600_000 }
}

describe('accounts and devices', () => {
  let deps: Awaited<ReturnType<typeof makeDeps>>
  beforeEach(async () => {
    deps = await makeDeps()
  })

  it('logs in and authenticates an account token', async () => {
    await createAccount(deps, 'A@x.io', 'pw')
    const { account_token } = await login(deps, 'a@x.io', 'pw')
    expect(account_token).toMatch(/^abst_/)
    expect((await authenticateAccount(deps, account_token)).accountId).toBeTruthy()
  })

  it('rejects a wrong password and an unknown email with the same error', async () => {
    await createAccount(deps, 'a@x.io', 'pw')
    const e1 = await login(deps, 'a@x.io', 'no').catch((e) => e)
    const e2 = await login(deps, 'b@x.io', 'pw').catch((e) => e)
    expect(e1.code).toBe('unauthorized')
    expect(e2.code).toBe('unauthorized')
    expect(e1.message).toBe(e2.message)
  })

  it('refuses a duplicate email', async () => {
    await createAccount(deps, 'a@x.io', 'pw')
    await expect(createAccount(deps, 'A@X.IO', 'pw')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('expires account tokens', async () => {
    const clock = { t: Date.now() }
    const d = { ...deps, now: () => new Date(clock.t) }
    await createAccount(d, 'a@x.io', 'pw')
    const { account_token } = await login(d, 'a@x.io', 'pw')
    clock.t += 3600_001
    await expect(authenticateAccount(d, account_token)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('enrols a device only on a vault the account belongs to, and revokes it', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: b } = await createAccount(deps, 'b@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    await expect(enrolDevice(deps, b, v, 'phone', 'mobile')).rejects.toMatchObject({
      code: 'forbidden',
    })
    const { device_id, device_token } = await enrolDevice(deps, a, v, 'laptop', 'desktop')
    const who = await authenticateDevice(deps, device_token)
    expect(who).toMatchObject({ deviceId: device_id, accountId: a, vaultId: v, name: 'laptop' })
    expect(await listDevices(deps, a)).toHaveLength(1)
    await revokeDevice(deps, a, device_id)
    await expect(authenticateDevice(deps, device_token)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('refuses a disabled account at login and on a token it already holds', async () => {
    const { id } = await createAccount(deps, 'a@x.io', 'pw')
    const { account_token } = await login(deps, 'a@x.io', 'pw')
    const wrong = await login(deps, 'a@x.io', 'no').catch((e) => e)
    await deps.db
      .updateTable('accounts')
      .set({ disabled_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
    const disabled = await login(deps, 'a@x.io', 'pw').catch((e) => e)
    expect(disabled.code).toBe('unauthorized')
    expect(disabled.message).toBe(wrong.message)
    await expect(authenticateAccount(deps, account_token)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('resets a password, keeping the old one and the tokens it issued out', async () => {
    await createAccount(deps, 'a@x.io', 'pw')
    const { account_token } = await login(deps, 'a@x.io', 'pw')
    await resetPassword(deps, 'A@x.io ', 'pw2')
    await expect(authenticateAccount(deps, account_token)).rejects.toMatchObject({
      code: 'unauthorized',
    })
    await expect(login(deps, 'a@x.io', 'pw')).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await login(deps, 'a@x.io', 'pw2')).account_token).toMatch(/^abst_/)
  })

  it('reports an unknown email to a password reset', async () => {
    await expect(resetPassword(deps, 'nobody@x.io', 'pw')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('lists the live devices of an account with their vault and platform', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: b } = await createAccount(deps, 'b@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    const { device_id } = await enrolDevice(deps, a, v, 'laptop', 'desktop')
    const { device_id: gone } = await enrolDevice(deps, a, v, 'old phone', 'mobile')
    await revokeDevice(deps, a, gone)

    const devices = await listDevices(deps, a)
    expect(devices).toEqual([
      {
        id: device_id,
        name: 'laptop',
        platform: 'desktop',
        vault_id: v,
        last_seen_at: null,
        created_at: expect.any(String),
        enrolled_by: null,
      },
    ])
    expect(await listDevices(deps, b)).toEqual([])
  })

  it('touches last_seen_at at most once a minute', async () => {
    const clock = { t: Date.parse('2026-09-04T10:00:00.000Z') }
    const d = { ...deps, now: () => new Date(clock.t) }
    const { id: a } = await createAccount(d, 'a@x.io', 'pw')
    const { id: v } = await createVault({ db: d.db }, a, 'Vault')
    const { device_token } = await enrolDevice(d, a, v, 'laptop', 'desktop')

    await authenticateDevice(d, device_token)
    const first = (await listDevices(d, a))[0]?.last_seen_at
    expect(first).toBe('2026-09-04T10:00:00.000Z')

    clock.t += 59_000
    await authenticateDevice(d, device_token)
    expect((await listDevices(d, a))[0]?.last_seen_at).toBe(first)

    clock.t += 2_000
    await authenticateDevice(d, device_token)
    expect((await listDevices(d, a))[0]?.last_seen_at).toBe('2026-09-04T10:01:01.000Z')
  })

  it('revokes only for the account that owns the device', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: b } = await createAccount(deps, 'b@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    const { device_id, device_token } = await enrolDevice(deps, a, v, 'laptop', 'desktop')
    await expect(revokeDevice(deps, b, device_id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(revokeDevice(deps, a, 'no-such-device')).rejects.toMatchObject({
      code: 'not_found',
    })
    expect((await authenticateDevice(deps, device_token)).deviceId).toBe(device_id)
  })

  it('rejects an unknown device token', async () => {
    await expect(authenticateDevice(deps, 'absd_nonsense')).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('counts the owner and an invited account as members, and nobody else', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: b } = await createAccount(deps, 'b@x.io', 'pw')
    const { id: c } = await createAccount(deps, 'c@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    await deps.db
      .insertInto('vault_members')
      .values({ vault_id: v, account_id: b, role: 'member' })
      .execute()
    expect(await isMember(deps.db, v, a)).toBe(true)
    expect(await isMember(deps.db, v, b)).toBe(true)
    expect(await isMember(deps.db, v, c)).toBe(false)
    const { device_id } = await enrolDevice(deps, b, v, 'phone', 'mobile')
    expect(device_id).toBeTruthy()
  })

  it('starts a vault at sequence zero with default settings and an owner row', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    const vault = await deps.db
      .selectFrom('vaults')
      .selectAll()
      .where('id', '=', v)
      .executeTakeFirstOrThrow()
    expect(vault.name).toBe('Vault')
    expect(vault.owner_account_id).toBe(a)
    expect(JSON.parse(vault.settings)).toMatchObject({
      conflict: 'merge',
      scripts_folder: 'Scripts',
    })
    const seq = await deps.db
      .selectFrom('vault_seq')
      .selectAll()
      .where('vault_id', '=', v)
      .executeTakeFirstOrThrow()
    expect(seq).toMatchObject({ head_seq: 0, epoch: 0 })
    const members = await deps.db
      .selectFrom('vault_members')
      .selectAll()
      .where('vault_id', '=', v)
      .execute()
    expect(members).toEqual([{ vault_id: v, account_id: a, role: 'owner' }])
  })
  it('spends the same work on an unknown email as on a wrong password', async () => {
    await createAccount(deps, 'a@x.io', 'pw')
    // Warm the dummy hash, so its one-off derivation is not charged to the first sample.
    await login(deps, 'nobody@x.io', 'pw').catch(() => undefined)

    const time = async (email: string): Promise<number> => {
      const started = performance.now()
      await login(deps, email, 'wrong').catch(() => undefined)
      return performance.now() - started
    }
    const samples = async (email: string): Promise<number> => {
      const runs: number[] = []
      for (let i = 0; i < 5; i += 1) runs.push(await time(email))
      return runs.sort((x, y) => x - y)[2] as number
    }

    const unknown = await samples('nobody@x.io')
    const wrongPassword = await samples('a@x.io')
    // Medians of five, and a deliberately loose bound: this asserts only that the
    // miss path still runs a scrypt, not that a shared machine keeps steady time.
    const [slow, fast] =
      unknown > wrongPassword ? [unknown, wrongPassword] : [wrongPassword, unknown]
    expect(fast).toBeGreaterThan(slow * 0.4)
  })

  it('refuses a device whose account has been disabled', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    const { device_token } = await enrolDevice(deps, a, v, 'laptop', 'desktop')
    expect((await authenticateDevice(deps, device_token)).accountId).toBe(a)

    await deps.db
      .updateTable('accounts')
      .set({ disabled_at: new Date().toISOString() })
      .where('id', '=', a)
      .execute()
    await expect(authenticateDevice(deps, device_token)).rejects.toMatchObject({
      code: 'unauthorized',
    })
  })

  it('refuses to enrol a platform it does not know', async () => {
    const { id: a } = await createAccount(deps, 'a@x.io', 'pw')
    const { id: v } = await createVault({ db: deps.db }, a, 'Vault')
    await expect(
      enrolDevice(deps, a, v, 'watch', 'watch' as DeviceInfo['platform'])
    ).rejects.toThrow()
    expect(await listDevices(deps, a)).toEqual([])
  })

  it('treats an unparsable last_seen_at as never seen', async () => {
    const clock = { t: Date.parse('2026-09-04T10:00:00.000Z') }
    const d = { ...deps, now: () => new Date(clock.t) }
    const { id: a } = await createAccount(d, 'a@x.io', 'pw')
    const { id: v } = await createVault({ db: d.db }, a, 'Vault')
    const { device_id, device_token } = await enrolDevice(d, a, v, 'laptop', 'desktop')
    await d.db
      .updateTable('devices')
      .set({ last_seen_at: 'not a timestamp' })
      .where('id', '=', device_id)
      .execute()

    await authenticateDevice(d, device_token)
    expect((await listDevices(d, a))[0]?.last_seen_at).toBe('2026-09-04T10:00:00.000Z')
  })
})
