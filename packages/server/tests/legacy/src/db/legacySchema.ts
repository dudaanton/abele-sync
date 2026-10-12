import type { Generated } from 'kysely'
export interface AccountsTable {
  id: string
  email: string
  password_hash: string
  created_at: string
  disabled_at: string | null
}

export interface AccountTokensTable {
  token_hash: string
  account_id: string
  expires_at: string
  /** Null legacy sessions cannot establish fresh owner authentication. */
  issued_at: Generated<string | null>
}

export interface VaultsTable {
  id: string
  owner_account_id: string
  name: string
  /** JSON: VaultSettings. */
  settings: string
  created_at: string
}

export interface VaultMembersTable {
  vault_id: string
  account_id: string
  role: string
}

export interface DevicesTable {
  id: string
  account_id: string
  vault_id: string
  name: string
  platform: string
  token_hash: string
  /** JSON: the device's selective-sync rules. */
  selective: string
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
  /** The device whose token enrolled this one (`POST /v1/devices/self/siblings`); null for an account's. */
  enrolled_by: string | null
}

declare module '../../../../src/db/schema.js' {
  interface Database {
    accounts: AccountsTable
    account_tokens: AccountTokensTable
    vaults: VaultsTable
    vault_members: VaultMembersTable
    devices: DevicesTable
    account_authority: { account_id: string; revision: Generated<number> }
  }
}
