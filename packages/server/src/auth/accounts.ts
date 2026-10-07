import { AbeleError, credentialFacet, type LoginResponse } from '@abele/sync-protocol'
import { randomBytes } from 'node:crypto'
import { sql, type Kysely } from 'kysely'
import type { Database } from '../db/schema.js'
import { newId } from '../ids.js'
import { hashPassword, hashToken, newToken, verifyPassword } from './hash.js'
import { lockAccounts } from './accountFence.js'

/** What the auth functions need: the database, the token pepper, and a clock the tests can move. */
export interface AuthDeps {
  db: Kysely<Database>
  pepper: string
  accountTokenTtlMs: number
  now?: () => Date
}

/**
 * Every way of failing to log in answers with this one sentence, so a caller
 * cannot tell an unknown email from a wrong password or a disabled account.
 */
const LOGIN_FAILED = 'invalid email or password'

/**
 * A hash of a password nobody holds. Failing logins verify against it so that an
 * unknown or disabled email costs the same one scrypt as a wrong password, and
 * the response time tells an attacker nothing about who has an account. It is
 * derived on first use rather than at import so that loading the module is cheap.
 */
let dummyHash: Promise<string> | undefined
const dummyPasswordHash = (): Promise<string> =>
  (dummyHash ??= hashPassword(randomBytes(16).toString('hex')))

/** Create an account. The email is the identity, so it is normalised and must be free. */
export async function createAccount(
  deps: AuthDeps,
  email: string,
  password: string
): Promise<{ id: string }> {
  const normalised = normaliseEmail(email)
  const taken = await deps.db
    .selectFrom('accounts')
    .select('id')
    .where('email', '=', normalised)
    .executeTakeFirst()
  if (taken) throw new AbeleError('conflict', 'that email already has an account')

  const id = newId(),
    passwordHash = await hashPassword(password)
  await deps.db.transaction().execute(async (tx) => {
    await tx
      .insertInto('accounts')
      .values({
        id,
        email: normalised,
        password_hash: passwordHash,
        created_at: authNow(deps).toISOString(),
        disabled_at: null,
      })
      .execute()
    await tx.insertInto('account_authority').values({ account_id: id }).execute()
  })
  return { id }
}

/** Exchange an email and password for an account token. */
export async function login(
  deps: AuthDeps,
  email: string,
  password: string
): Promise<LoginResponse> {
  const account = await deps.db
    .selectFrom('accounts')
    .select(['id', 'password_hash', 'disabled_at'])
    .where('email', '=', normaliseEmail(email))
    .executeTakeFirst()
  if (!account || account.disabled_at !== null) {
    await verifyPassword(password, await dummyPasswordHash())
    throw new AbeleError('unauthorized', LOGIN_FAILED)
  }
  if (!(await verifyPassword(password, account.password_hash))) {
    throw new AbeleError('unauthorized', LOGIN_FAILED)
  }

  const token = newToken('abst')
  const issuedAt = authNow(deps)
  const expiresAt = new Date(issuedAt.getTime() + deps.accountTokenTtlMs).toISOString()
  await deps.db.transaction().execute(async (tx) => {
    await lockAccounts(tx, [account.id])
    const current = await tx
      .selectFrom('accounts')
      .select(['password_hash', 'disabled_at'])
      .where('id', '=', account.id)
      .executeTakeFirst()
    if (
      !current ||
      current.disabled_at !== null ||
      current.password_hash !== account.password_hash
    ) {
      throw new AbeleError('unauthorized', LOGIN_FAILED)
    }
    await tx
      .insertInto('account_tokens')
      .values({
        token_hash: hashToken(deps.pepper, token),
        account_id: account.id,
        expires_at: expiresAt,
        issued_at: issuedAt.toISOString(),
      })
      .execute()
  })
  return { account_token: token, expires_at: expiresAt }
}

/** Prove the device's account password on this request, without issuing or caching a token. */
export async function verifyAccountPassword(
  deps: Pick<AuthDeps, 'db'>,
  accountId: string,
  password: string
): Promise<void> {
  const account = await deps.db
    .selectFrom('accounts')
    .select(['password_hash', 'disabled_at'])
    .where('id', '=', accountId)
    .executeTakeFirst()
  const enabled = account !== undefined && account.disabled_at === null
  const hash = enabled ? account.password_hash : await dummyPasswordHash()
  if (!(await verifyPassword(password, hash)) || !enabled) {
    throw new AbeleError('unauthorized', 'invalid account password')
  }
}

/** Resolve an account token to its account, refusing unknown, expired and disabled ones. */
export async function authenticateAccount(
  deps: AuthDeps,
  token: string
): Promise<{ accountId: string }> {
  const invalid = new AbeleError('unauthorized', 'invalid or expired account token')
  if (credentialFacet(token) !== 'account') throw invalid
  const row = await deps.db
    .selectFrom('account_tokens')
    .select(['account_id', 'expires_at'])
    .where('token_hash', '=', hashToken(deps.pepper, token))
    .executeTakeFirst()
  if (!row || Date.parse(row.expires_at) <= authNow(deps).getTime()) throw invalid

  const account = await deps.db
    .selectFrom('accounts')
    .select(['id', 'disabled_at'])
    .where('id', '=', row.account_id)
    .executeTakeFirst()
  if (!account || account.disabled_at !== null) throw invalid
  return { accountId: account.id }
}

/** Set a new password and drop the tokens the old one issued. */
export async function resetPassword(
  deps: AuthDeps,
  email: string,
  password: string
): Promise<void> {
  const normalised = normaliseEmail(email)
  const account = await deps.db
    .selectFrom('accounts')
    .select('id')
    .where('email', '=', normalised)
    .executeTakeFirst()
  if (!account) throw new AbeleError('not_found', 'no account has that email')

  const passwordHash = await hashPassword(password)
  await deps.db.transaction().execute(async (tx) => {
    await lockAccounts(tx, [account.id], true)
    await tx
      .updateTable('accounts')
      .set({ password_hash: passwordHash })
      .where('id', '=', account.id)
      .execute()
    await tx.deleteFrom('account_tokens').where('account_id', '=', account.id).execute()
    await tx
      .updateTable('account_authority')
      .set({ revision: sql<number>`revision + 1` })
      .where('account_id', '=', account.id)
      .execute()
  })
}

/** Emails are compared case-insensitively and without surrounding space. */
const normaliseEmail = (email: string): string => email.trim().toLowerCase()

/** The clock the auth functions read. Tests inject one; production takes the wall clock. */
export const authNow = (deps: AuthDeps): Date => (deps.now ?? (() => new Date()))()
