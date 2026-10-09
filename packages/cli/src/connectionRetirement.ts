import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import {
  ConnectionBindingSchema,
  decodeExternalDocument,
  ExternalStateError,
  sameConnection,
  type ConnectionBinding,
  type ExternalDocument,
} from '@abele/sync-core'
import { stateFolder, writeOwnedJson } from './config.js'
import { ACTIVATION_FILE, assertLocalSafety } from './externalSafety.js'
import {
  assertDisconnectReady,
  assertPreparedInventory,
  READY_KEY,
} from './externalMaterialization.js'

export const RETIREMENT_FILE = 'external-retirement.json'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const phases = [
  'retirement-written',
  'connection-removed',
  'activation-removed',
  'inventory-retired',
] as const
type Phase = (typeof phases)[number]
interface Retirement {
  format: 'abele.cli.retirement'
  schema: 1
  phase: Phase
  ledgerFile: 'state.db' | 'agent.sqlite'
  ledgerIdentity: string
  binding: ConnectionBinding
  revision: number
  ready: string
  configStamp: string
  activationStamp: string | null
}
function refuse(): never {
  throw new ExternalStateError('recovery-required')
}
const stamp = (file: string) => (existsSync(file) ? hash(readFileSync(file)) : null)
function ledgerIdentity(file: string, db: SqliteDatabase.Database): string {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) refuse()
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('daemon:ledger-instance-id') as { value: string } | undefined
  if (!row?.value) refuse()
  return `${stat.dev}:${stat.ino}:${row.value}`
}
function get(db: SqliteDatabase.Database, key: string): string | null {
  return (
    (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(`daemon:${key}`) as
        { value: string } | undefined
    )?.value ?? null
  )
}
/** Called only after preparation AND the caller's revoke/explicit safe-force decision.
 * The bounded receipt contains identity and local proofs, never bearer credentials.
 */
export async function retirePreparedConnection(
  dir: string,
  ledgerFile: 'state.db' | 'agent.sqlite',
  binding: ConnectionBinding,
  guard: () => void,
  afterWrite: (phase: Phase) => void = () => {}
): Promise<void> {
  guard()
  if (existsSync(join(stateFolder(dir), RETIREMENT_FILE))) refuse()
  assertPreparedInventory(dir, ledgerFile, [binding])
  const file = join(stateFolder(dir), ledgerFile),
    db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
  let record: Retirement
  try {
    const doc = decodeExternalDocument(get(db, 'external-files') ?? '')
    record = {
      format: 'abele.cli.retirement',
      schema: 1,
      phase: 'retirement-written',
      ledgerFile,
      ledgerIdentity: ledgerIdentity(file, db),
      binding,
      revision: doc.revision,
      ready: get(db, READY_KEY)!,
      configStamp: stamp(
        join(stateFolder(dir), ledgerFile === 'state.db' ? 'config.json' : 'agent.json')
      )!,
      activationStamp: stamp(join(stateFolder(dir), ACTIVATION_FILE)),
    }
  } finally {
    db.close()
  }
  writeOwnedJson(dir, RETIREMENT_FILE, record, guard)
  afterWrite('retirement-written')
  await finish(dir, record, guard, afterWrite)
}
export async function resumeConnectionRetirement(
  dir: string,
  guard: () => void,
  expectedLedger?: 'state.db' | 'agent.sqlite'
): Promise<boolean> {
  guard()
  const marker = join(stateFolder(dir), RETIREMENT_FILE)
  if (!existsSync(marker)) return false
  const stat = lstatSync(marker)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) refuse()
  let record: Retirement
  try {
    record = JSON.parse(readFileSync(marker, 'utf8')) as Retirement
    if (
      record.format !== 'abele.cli.retirement' ||
      record.schema !== 1 ||
      !phases.includes(record.phase) ||
      !['state.db', 'agent.sqlite'].includes(record.ledgerFile) ||
      typeof record.ledgerIdentity !== 'string' ||
      typeof record.ready !== 'string' ||
      !Number.isSafeInteger(record.revision) ||
      record.revision < 0 ||
      !/^[a-f0-9]{64}$/.test(record.configStamp) ||
      !(record.activationStamp === null || /^[a-f0-9]{64}$/.test(record.activationStamp))
    )
      refuse()
    record.binding = ConnectionBindingSchema.parse(record.binding)
    if (
      (record.binding.mode === 'personal') !== (record.ledgerFile === 'state.db') ||
      (expectedLedger && expectedLedger !== record.ledgerFile)
    )
      refuse()
  } catch {
    refuse()
  }
  await finish(dir, record, guard)
  return true
}
async function finish(
  dir: string,
  record: Retirement,
  guard: () => void,
  afterWrite: (phase: Phase) => void = () => {}
): Promise<void> {
  const marker = join(stateFolder(dir), RETIREMENT_FILE),
    config = join(
      stateFolder(dir),
      record.ledgerFile === 'state.db' ? 'config.json' : 'agent.json'
    ),
    activation = join(stateFolder(dir), ACTIVATION_FILE),
    file = join(stateFolder(dir), record.ledgerFile)
  let expected = stamp(marker)
  const proofDoc: ExternalDocument = {
    schema: 1,
    ledgerId: 'retired',
    binding: record.binding,
    revision: record.revision,
    files: [],
    operations: [],
  }
  const check = () => {
    guard()
    if (
      stamp(marker) !== expected ||
      (stamp(config) !== null && stamp(config) !== record.configStamp) ||
      (stamp(activation) !== null && stamp(activation) !== record.activationStamp)
    )
      refuse()
    const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
    try {
      if (ledgerIdentity(file, db) !== record.ledgerIdentity) refuse()
      const value = get(db, 'external-files'),
        ready = get(db, READY_KEY)
      if (value !== null) {
        const doc = decodeExternalDocument(value)
        if (
          doc.files.length ||
          doc.operations.length ||
          doc.revision !== record.revision ||
          !sameConnection(doc.binding, record.binding) ||
          ready !== record.ready
        )
          refuse()
      } else if (ready !== null) refuse()
      assertDisconnectReady(dir, { getMeta: () => record.ready }, proofDoc)
    } finally {
      db.close()
    }
    assertLocalSafety(dir, true, true, false, false, false, {
      ledgerFile: record.ledgerFile,
      binding: record.binding,
      projections: new Set(),
      retiring: true,
    })
  }
  const phase = (next: Phase) => {
    check()
    record = { ...record, phase: next }
    writeOwnedJson(dir, RETIREMENT_FILE, record, check)
    expected = stamp(marker)
    afterWrite(next)
  }
  check()
  if (existsSync(config)) {
    check()
    rmSync(config)
  }
  phase('connection-removed')
  if (existsSync(activation)) {
    check()
    rmSync(activation)
  }
  phase('activation-removed')
  check()
  const db = new SqliteDatabase(file, { fileMustExist: true })
  let committing = false
  try {
    db.exec('BEGIN IMMEDIATE')
    if (get(db, 'external-files') !== null) {
      check()
      db.prepare('DELETE FROM meta WHERE key IN (?, ?) OR key LIKE ?').run(
        'daemon:external-files',
        `daemon:${READY_KEY}`,
        'daemon:external-install:%'
      )
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run('daemon:retired-connection-binding', JSON.stringify(record.binding))
    }
    check()
    committing = true
    db.exec('COMMIT')
  } catch (cause) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw new ExternalStateError(committing ? 'commit-unknown' : 'aborted', { cause })
  } finally {
    db.close()
  }
  phase('inventory-retired')
  check()
  rmSync(marker)
}
