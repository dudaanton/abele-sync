import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import { EngineError, ExternalStateError } from '@abele/sync-core'
import { normalizeServerUrl } from '@abele/sync-protocol'
import {
  readConfig,
  stateFolder,
  writeOwnedJson,
  personalBinding,
  type DaemonConfig,
} from './config.js'
import { assertLocalSafety, inspectProjectionInventory, SWITCH_FILE } from './externalSafety.js'

const CREDENTIALS = 'external-switch-credentials.json'
type Phase =
  | 'prepared'
  | 'credentials-staged'
  | 'ledger-retired'
  | 'connection-written'
  | 'confirmed'
  | 'retired'
const phases: Phase[] = [
  'prepared',
  'credentials-staged',
  'ledger-retired',
  'connection-written',
  'confirmed',
  'retired',
]
interface SwitchRecord {
  format: 'abele.cli.connection-switch'
  schema: 1
  phase: Phase
  credentialsSha: string
  oldStamp: string
  targetStamp: string
  keepLedger: boolean
  ledgerIdentity: string | null
}
interface Credentials {
  old: DaemonConfig | null
  target: DaemonConfig
  plan: Omit<SwitchRecord, 'phase' | 'credentialsSha'>
}
type WriteBoundary = Phase | 'credentials-written' | 'active-connection-written'
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function readEvidence(file: string, limit: number): Buffer {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) refuse()
  const bytes = readFileSync(file)
  if (bytes.length > limit) refuse()
  return bytes
}
const configStamp = (dir: string) => {
  const file = join(stateFolder(dir), 'config.json')
  return existsSync(file) ? hash(readFileSync(file)) : 'absent'
}
function ledgerIdentity(dir: string): string | null {
  const file = join(stateFolder(dir), 'state.db')
  if (!existsSync(file)) return null
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new EngineError('lost', 'unsafe switch ledger')
  // Read the actual on-disk identity without creating or migrating a database.
  const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
  try {
    const row = db
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('daemon:ledger-instance-id') as { value: string } | undefined
    return `${stat.dev}:${stat.ino}:${row?.value ?? 'legacy'}`
  } finally {
    db.close()
  }
}
function refuse(): never {
  const error = new ExternalStateError('recovery-required')
  error.message = 'connection switch requires recovery; credentials and inventory were preserved'
  throw error
}

/** Only a cleared retirement inventory can enter this bounded replacement protocol.
 * Credentials are staged separately; ordinary startup holds either surviving file.
 */
export async function replaceConnection(
  dir: string,
  target: DaemonConfig,
  sameVault: boolean,
  guard: () => void,
  revoke: (old: DaemonConfig, check: () => void) => Promise<void>,
  afterWrite: (phase: WriteBoundary) => void = () => {}
): Promise<void> {
  guard()
  personalBinding(target)
  const initialStamp = configStamp(dir)
  assertLocalSafety(dir, true)
  const preparing = () => {
    guard()
    if (configStamp(dir) !== initialStamp) refuse()
    assertLocalSafety(dir, true)
  }
  await inspectProjectionInventory(dir, { guard: preparing })
  preparing()
  guard()
  let old: DaemonConfig | null
  try {
    old = readConfig(dir)
  } catch {
    old = null
  }
  const oldStamp = configStamp(dir)
  const keepLedger =
    sameVault &&
    (old === null ||
      (normalizeServerUrl(old.serverUrl) === normalizeServerUrl(target.serverUrl) &&
        old.vaultId === target.vaultId))
  const identity = ledgerIdentity(dir)
  const targetBytes = `${JSON.stringify(target, null, 2)}\n`
  const plan: Credentials['plan'] = {
    format: 'abele.cli.connection-switch',
    schema: 1,
    oldStamp,
    targetStamp: hash(targetBytes),
    keepLedger,
    ledgerIdentity: identity,
  }
  const credentials: Credentials = { old, target, plan }
  if (Buffer.byteLength(JSON.stringify(credentials)) > 1024 * 1024) refuse()
  writeOwnedJson(dir, CREDENTIALS, credentials, preparing)
  afterWrite('credentials-written')
  const record: SwitchRecord = {
    ...plan,
    phase: 'prepared',
    credentialsSha: hash(readFileSync(join(stateFolder(dir), CREDENTIALS))),
  }
  // From this point the normal guard intentionally refuses the switch marker.
  writeOwnedJson(dir, SWITCH_FILE, record, () => {
    guard()
    if (configStamp(dir) !== oldStamp || ledgerIdentity(dir) !== identity) refuse()
  })
  afterWrite('prepared')
  await finish(dir, record, credentials, target.serverUrl, guard, revoke, afterWrite)
}

/** Resume the recorded target, never enroll again or infer a new binding from a vault ID. */
export async function resumeConnectionSwitch(
  dir: string,
  server: string,
  guard: () => void,
  revoke: (old: DaemonConfig, check: () => void) => Promise<void>
): Promise<boolean> {
  const marker = join(stateFolder(dir), SWITCH_FILE)
  if (!existsSync(marker)) {
    const stagedFile = join(stateFolder(dir), CREDENTIALS)
    if (!existsSync(stagedFile)) return false
    let staged: Credentials, bytes: Buffer
    try {
      bytes = readEvidence(stagedFile, 1024 * 1024)
      staged = JSON.parse(bytes.toString('utf8')) as Credentials
      personalBinding(staged.target)
      if (
        staged.plan.format !== 'abele.cli.connection-switch' ||
        staged.plan.schema !== 1 ||
        typeof staged.plan.keepLedger !== 'boolean' ||
        hash(`${JSON.stringify(staged.target, null, 2)}\n`) !== staged.plan.targetStamp ||
        normalizeServerUrl(staged.target.serverUrl) !== normalizeServerUrl(server)
      )
        refuse()
    } catch {
      return refuse()
    }
    const checkStaged = () => {
      guard()
      if (
        existsSync(marker) ||
        hash(readFileSync(stagedFile)) !== hash(bytes) ||
        configStamp(dir) !== staged.plan.oldStamp ||
        ledgerIdentity(dir) !== staged.plan.ledgerIdentity
      )
        refuse()
      assertLocalSafety(dir, true, true, false, false, true)
    }
    checkStaged()
    await inspectProjectionInventory(dir, { guard: checkStaged, selective: staged.old?.selective })
    checkStaged()
    writeOwnedJson(
      dir,
      SWITCH_FILE,
      { ...staged.plan, phase: 'prepared', credentialsSha: hash(bytes) },
      checkStaged
    )
  }
  let record: SwitchRecord, credentials: Credentials
  try {
    record = JSON.parse(readEvidence(marker, 4096).toString('utf8')) as SwitchRecord
    if (
      record.format !== 'abele.cli.connection-switch' ||
      record.schema !== 1 ||
      !phases.includes(record.phase) ||
      typeof record.keepLedger !== 'boolean' ||
      !(record.ledgerIdentity === null || typeof record.ledgerIdentity === 'string') ||
      Object.keys(record).some(
        (key) =>
          ![
            'format',
            'schema',
            'phase',
            'credentialsSha',
            'oldStamp',
            'targetStamp',
            'keepLedger',
            'ledgerIdentity',
          ].includes(key)
      ) ||
      !/^[a-f0-9]{64}$/.test(record.credentialsSha) ||
      !/^[a-f0-9]{64}$/.test(record.targetStamp)
    )
      refuse()
    if (record.phase === 'retired') {
      const markerStamp = hash(readFileSync(marker))
      const checkRetired = () => {
        guard()
        if (
          hash(readFileSync(marker)) !== markerStamp ||
          (existsSync(join(stateFolder(dir), CREDENTIALS)) &&
            hash(readEvidence(join(stateFolder(dir), CREDENTIALS), 1024 * 1024)) !==
              record.credentialsSha) ||
          configStamp(dir) !== record.targetStamp ||
          (record.keepLedger
            ? ledgerIdentity(dir) !== record.ledgerIdentity
            : ledgerIdentity(dir) !== null)
        )
          refuse()
        assertLocalSafety(dir, true, true, false, false, true)
      }
      checkRetired()
      const target = readConfig(dir)
      if (!target || normalizeServerUrl(target.serverUrl) !== normalizeServerUrl(server)) refuse()
      await inspectProjectionInventory(dir, { guard: checkRetired })
      checkRetired()
      rmSync(join(stateFolder(dir), CREDENTIALS), { force: true })
      checkRetired()
      rmSync(marker)
      return true
    }
    const bytes = readEvidence(join(stateFolder(dir), CREDENTIALS), 1024 * 1024)
    if (hash(bytes) !== record.credentialsSha) refuse()
    credentials = JSON.parse(bytes.toString('utf8')) as Credentials
    personalBinding(credentials.target)
    if (credentials.old !== null && normalizeServerUrl(credentials.old.serverUrl) !== null)
      personalBinding(credentials.old)
    if (hash(`${JSON.stringify(credentials.target, null, 2)}\n`) !== record.targetStamp) refuse()
  } catch {
    return refuse()
  }
  await finish(dir, record, credentials, server, guard, revoke)
  return true
}

async function finish(
  dir: string,
  record: SwitchRecord,
  credentials: Credentials,
  server: string,
  guard: () => void,
  revoke: (old: DaemonConfig, check: () => void) => Promise<void>,
  afterWrite: (phase: WriteBoundary) => void = () => {}
): Promise<void> {
  if (normalizeServerUrl(server) !== normalizeServerUrl(credentials.target.serverUrl)) refuse()
  let expectedMarker = hash(readFileSync(join(stateFolder(dir), SWITCH_FILE)))
  const check = () => {
    guard()
    if (
      hash(readFileSync(join(stateFolder(dir), SWITCH_FILE))) !== expectedMarker ||
      hash(readFileSync(join(stateFolder(dir), CREDENTIALS))) !== record.credentialsSha
    )
      refuse()
    const stamp = configStamp(dir)
    if (stamp !== record.oldStamp && stamp !== record.targetStamp) refuse()
    const identity = ledgerIdentity(dir)
    if (identity !== record.ledgerIdentity && (record.keepLedger || identity !== null)) refuse()
    assertLocalSafety(dir, true, true, false, false, true)
  }
  check()
  await inspectProjectionInventory(dir, { guard: check, selective: credentials.old?.selective })
  const phase = (next: Phase) => {
    check()
    record = { ...record, phase: next }
    writeOwnedJson(dir, SWITCH_FILE, record, check)
    expectedMarker = hash(readFileSync(join(stateFolder(dir), SWITCH_FILE)))
    afterWrite(next)
  }
  if (record.phase === 'prepared') phase('credentials-staged')
  if (record.phase === 'credentials-staged') {
    if (!record.keepLedger)
      for (const suffix of ['', '-wal', '-shm']) {
        check()
        rmSync(join(stateFolder(dir), `state.db${suffix}`), { force: true })
      }
    phase('ledger-retired')
  }
  if (record.phase === 'ledger-retired') {
    check()
    writeOwnedJson(dir, 'config.json', credentials.target, check)
    afterWrite('active-connection-written')
    phase('connection-written')
  }
  if (configStamp(dir) !== record.targetStamp) refuse()
  if (record.phase === 'connection-written') phase('confirmed')
  check()
  if (credentials.old !== null) await revoke(credentials.old, check)
  phase('retired')
  check()
  rmSync(join(stateFolder(dir), CREDENTIALS))
  guard()
  if (
    configStamp(dir) !== record.targetStamp ||
    hash(readFileSync(join(stateFolder(dir), SWITCH_FILE))) !== expectedMarker
  )
    refuse()
  rmSync(join(stateFolder(dir), SWITCH_FILE))
}
