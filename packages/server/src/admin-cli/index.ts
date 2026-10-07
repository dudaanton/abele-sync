#!/usr/bin/env node
import { cp, mkdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command, CommanderError } from 'commander'
import { sql, type Kysely } from 'kysely'
import { createAccount, resetPassword, type AuthDeps } from '../auth/accounts.js'
import { BlobStore } from '../blobs/store.js'
import { createUploadManager } from '../blobs/uploads.js'
import { loadConfig, type Config } from '../config.js'
import { createDb, type Dialect } from '../db/connect.js'
import { runMigrations } from '../db/migrate.js'
import type { Database } from '../db/schema.js'
import { runRetention } from '../history/retention.js'
import { createVault } from '../vault/vaults.js'
import { verifyBackup } from './verifyBackup.js'

/**
 * The operator's side of the server: the handful of things that have to be done
 * from a shell because no route may do them — making the first account, resetting
 * a password nobody can log in with, running the sweep by hand, taking a backup.
 *
 * It opens its own database from `ABELE_DATABASE_URL` and migrates it first, so
 * it works on a server that has never been started. Nothing is written straight
 * to the console: everything goes through `out`, which the tests read instead of
 * printing, and no token, password or hash is ever among it.
 */

export interface AdminOutput {
  log(s: string): void
  error(s: string): void
}

/** What a command is handed once the database is open. */
interface AdminContext {
  config: Config
  db: Kysely<Database>
  dialect: Dialect
  store: BlobStore
}

type AdminCommand = (ctx: AdminContext) => Promise<void>

/** Run one CLI invocation and answer with the exit code it deserves. */
export async function runAdmin(
  argv: string[],
  env: NodeJS.ProcessEnv,
  out: AdminOutput
): Promise<number> {
  // Parsing only chooses the command; nothing is opened until one was chosen.
  const chosen: { command: AdminCommand | null } = { command: null }
  try {
    await buildProgram(out, chosen).parseAsync(argv, { from: 'user' })
  } catch (error) {
    // `--help` and `--version` are commander leaving early, not the operator failing.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1
    return fail(out, error)
  }
  if (chosen.command === null) return 0

  try {
    const config = loadConfig(env)
    const handle = createDb(config.databaseUrl)
    try {
      await runMigrations(handle.db)
      await chosen.command({
        config,
        db: handle.db,
        dialect: handle.dialect,
        store: new BlobStore(config.blobDir, config.masterKey),
      })
    } finally {
      await handle.close()
    }
  } catch (error) {
    return fail(out, error)
  }
  return 0
}

function buildProgram(out: AdminOutput, chosen: { command: AdminCommand | null }): Command {
  const program = new Command()
  program
    .name('abele-sync-admin')
    .description('operator commands for an abele sync server')
    // A CLI that is also a function must not take the process down with it.
    .exitOverride()
    .configureOutput({
      writeOut: (s) => out.log(s.replace(/\n$/, '')),
      writeErr: (s) => out.error(s.replace(/\n$/, '')),
    })

  program
    .command('create-account')
    .description('create an account')
    .requiredOption('--email <email>', 'the email that identifies it')
    .requiredOption('--password <password>', 'its first password')
    .action((opts: { email: string; password: string }) => {
      chosen.command = async (ctx) => {
        const { id } = await createAccount(authDeps(ctx), opts.email, opts.password)
        out.log(`created account ${id} for ${normaliseEmail(opts.email)}`)
      }
    })

  program
    .command('reset-password')
    .description('set a new password and drop the tokens the old one issued')
    .requiredOption('--email <email>', 'the account to reset')
    .requiredOption('--password <password>', 'its new password')
    .action((opts: { email: string; password: string }) => {
      chosen.command = async (ctx) => {
        const email = normaliseEmail(opts.email)
        // Asked first, so that an operator's typo comes back with the address they typed.
        await accountFor(ctx.db, email)
        await resetPassword(authDeps(ctx), email, opts.password)
        out.log(`reset the password for ${email}`)
      }
    })

  program
    .command('create-vault')
    .description('create a vault owned by an existing account')
    .requiredOption('--owner-email <email>', 'the account that will own it')
    .requiredOption('--name <name>', 'what to call it')
    .action((opts: { ownerEmail: string; name: string }) => {
      chosen.command = async (ctx) => {
        const email = normaliseEmail(opts.ownerEmail)
        const owner = await accountFor(ctx.db, email)
        const { id } = await createVault({ db: ctx.db }, owner.id, opts.name)
        out.log(`created vault ${id} named ${opts.name} for ${email}`)
      }
    })

  program
    .command('list-vaults')
    .description('every vault on this server, with its owner')
    .action(() => {
      chosen.command = async (ctx) => {
        const vaults = await ctx.db
          .selectFrom('vaults')
          // A left join: a vault whose owner row went missing must still be listed.
          .leftJoin('accounts', 'accounts.id', 'vaults.owner_account_id')
          .select(['vaults.id as id', 'vaults.name as name', 'accounts.email as owner'])
          .orderBy('vaults.created_at')
          .execute()
        if (vaults.length === 0) {
          out.log('no vaults')
          return
        }
        for (const vault of vaults) {
          out.log(`${vault.id}  ${vault.name}  ${vault.owner ?? '(no owner)'}`)
        }
      }
    })

  program
    .command('gc')
    .description('run retention once, now')
    .action(() => {
      chosen.command = async (ctx) => {
        const report = await runRetention({
          db: ctx.db,
          dialect: ctx.dialect,
          store: ctx.store,
          uploads: createUploadManager({ config: ctx.config, db: ctx.db, store: ctx.store }),
          idempotencyTtlMs: ctx.config.idempotencyTtlMs,
          now: () => new Date(),
        })
        out.log(`versions removed: ${report.versions_removed}`)
        out.log(`blobs removed: ${report.blobs_removed}`)
        out.log(`unreferenced blobs removed: ${report.unreferenced_removed}`)
        out.log(`uploads swept: ${report.uploads_swept}`)
        out.log(`idempotency keys swept: ${report.idempotency_swept}`)
      }
    })

  program
    .command('backup')
    .description('copy the database and the blobs into a directory')
    .requiredOption('--to <dir>', 'where to write the backup')
    .action((opts: { to: string }) => {
      chosen.command = (ctx) => backup(ctx, resolve(opts.to), out)
    })

  return program
}

/**
 * A backup is the database beside the blobs. SQLite writes itself out with
 * `VACUUM INTO`, which refuses a file that exists — so the refusal is made
 * legible here rather than left as a sqlite error, and the blob directory is
 * held to the same rule. Both targets are checked before anything is written:
 * a backup that half happened is worse than one that did not start.
 *
 * Every blob the snapshot names is authenticated and hashed after copying. GC
 * may race the copy, but cannot make an incomplete backup report success.
 * Postgres requires an externally coordinated snapshot and is refused here.
 */
async function backup(ctx: AdminContext, dir: string, out: AdminOutput): Promise<void> {
  if (ctx.dialect !== 'sqlite') {
    throw new Error(
      'Postgres backup requires an externally coordinated pg_dump and blob snapshot with GC stopped; this command cannot produce a verified backup'
    )
  }
  const database = join(dir, 'abele.db')
  const blobs = join(dir, 'blobs')
  const occupied = (path: string): Error =>
    new Error(`${path} already exists; move it aside or back up into another directory`)

  if (await exists(database)) throw occupied(database)
  if (await exists(blobs)) throw occupied(blobs)
  await mkdir(dir, { recursive: true })

  // `vacuum into` takes a literal, not a bind parameter; doubling the quote is sqlite's escape.
  await sql.raw(`vacuum into '${database.replace(/'/g, "''")}'`).execute(ctx.db)
  out.log(`database: ${database}`)

  if (await exists(ctx.config.blobDir)) {
    const uploads = join(ctx.config.blobDir, 'uploads')
    await cp(ctx.config.blobDir, blobs, {
      recursive: true,
      // Half-sent upload parts are not blobs; a backup has nothing to do with them.
      filter: (source) => source !== uploads && !source.startsWith(uploads + sep),
    })
    out.log(`blobs: ${blobs}`)
  } else {
    await mkdir(blobs, { recursive: true })
    out.log(`blobs: ${blobs} (there is nothing in ${ctx.config.blobDir} yet)`)
  }
  await verifyBackup(database, blobs, ctx.config.masterKey)
  out.log('backup verified: every snapshot version has intact bytes')
}

const authDeps = (ctx: AdminContext): AuthDeps => ({
  db: ctx.db,
  pepper: ctx.config.tokenPepper,
  accountTokenTtlMs: ctx.config.accountTokenTtlMs,
})

/** The account that email names, or a failure that says which email nobody has. */
async function accountFor(db: Kysely<Database>, email: string): Promise<{ id: string }> {
  const account = await db
    .selectFrom('accounts')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst()
  if (account === undefined) throw new Error(`no account has the email ${email}`)
  return account
}

/** The same normalisation `accounts.ts` stores emails under, so a lookup here finds them. */
const normaliseEmail = (email: string): string => email.trim().toLowerCase()

/** Is that path there? Only ENOENT is absent; a disk that will not answer says so instead. */
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )

/** Whatever went wrong, in one sentence on `error`, and a failing exit code. */
function fail(out: AdminOutput, error: unknown): number {
  out.error(error instanceof Error ? error.message : String(error))
  return 1
}

/* c8 ignore start -- the bin, which no test runs as a module */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runAdmin(process.argv.slice(2), process.env, console))
}
/* c8 ignore stop */
