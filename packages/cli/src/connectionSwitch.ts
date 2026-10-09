import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import {
  EngineError,
  ExternalStateError,
  decodeExternalDocument,
  sameConnection,
  ConnectionBindingSchema,
  type ConnectionBinding,
} from '@abele/sync-core'
import { normalizeServerUrl } from '@abele/sync-protocol'
import {
  readConfig,
  stateFolder,
  writeOwnedJson,
  personalBinding,
  readConfigDescriptor,
  parseLocalDescriptor,
  type LocalDescriptor,
  type DaemonConfig,
} from './config.js'
import {
  assertLocalSafety,
  inspectProjectionInventory,
  SWITCH_FILE,
  ACTIVATION_FILE,
} from './externalSafety.js'
import {
  assertPreparedInventory,
  READY_KEY,
  validateLifecycleLedger,
} from './externalMaterialization.js'
import { SqliteStateStore } from './sqliteState.js'

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
interface ExternalSwitch {
  oldBinding: ConnectionBinding
  targetBinding: ConnectionBinding
  targetDescriptor: LocalDescriptor | null
  oldActivationSha: string | null
  keepEntries: boolean
}
interface SwitchRecord {
  format: 'abele.cli.connection-switch'
  schema: 1
  phase: Phase
  credentialsSha: string
  oldStamp: string
  targetStamp: string
  keepLedger: boolean
  ledgerIdentity: string | null
  external?: ExternalSwitch | null
}
interface Credentials {
  old: DaemonConfig | null
  target: DaemonConfig
  plan: Omit<SwitchRecord, 'phase' | 'credentialsSha'>
}
type WriteBoundary =
  | Phase
  | 'credentials-written'
  | 'active-connection-written'
  | 'ledger-bound-written'
  | 'activation-written'
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
  let previous: DaemonConfig | null
  try {
    previous = readConfig(dir)
  } catch {
    previous = null
  }
  const externalFile = join(stateFolder(dir), 'state.db')
  let external: ExternalSwitch | null = null
  if (existsSync(externalFile)) {
    const raw = SqliteStateStore.openReadOnlySnapshot(externalFile)
    try {
      const value = raw.getMeta('external-files')
      if (value !== null) {
        if (!previous) refuse()
        const doc = decodeExternalDocument(value)
        const descriptor = readConfigDescriptor(dir)
        await validateLifecycleLedger(
          dir,
          'state.db',
          personalBinding(previous, doc.binding.generation),
          raw
        )
        if (doc.files.length || doc.operations.length) assertLocalSafety(dir, true)
        assertPreparedInventory(dir, 'state.db', [doc.binding])
        const targetBinding = personalBinding(target, doc.binding.generation + 1)
        external = {
          oldBinding: doc.binding,
          targetBinding,
          targetDescriptor: descriptor ? { ...descriptor, binding: targetBinding } : null,
          oldActivationSha: descriptor
            ? hash(readFileSync(join(stateFolder(dir), ACTIVATION_FILE)))
            : null,
          keepEntries:
            sameVault &&
            normalizeServerUrl(previous.serverUrl) === normalizeServerUrl(target.serverUrl) &&
            previous.vaultId === target.vaultId,
        }
      }
    } finally {
      raw.close()
    }
  }
  const initialInventory = () =>
    external
      ? assertPreparedInventory(dir, 'state.db', [external.oldBinding])
      : assertLocalSafety(dir, true)
  initialInventory()
  const preparing = () => {
    guard()
    if (configStamp(dir) !== initialStamp) refuse()
    initialInventory()
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
    external !== null ||
    (sameVault &&
      (old === null ||
        (normalizeServerUrl(old.serverUrl) === normalizeServerUrl(target.serverUrl) &&
          old.vaultId === target.vaultId)))
  const identity = ledgerIdentity(dir)
  const targetValue = external?.targetDescriptor
    ? { format: 'abele.cli', schema: 2, connection: target, descriptor: external.targetDescriptor }
    : target
  const targetBytes = `${JSON.stringify(targetValue, null, 2)}\n`
  const plan: Credentials['plan'] = {
    format: 'abele.cli.connection-switch',
    schema: 1,
    oldStamp,
    targetStamp: hash(targetBytes),
    keepLedger,
    ledgerIdentity: identity,
    external,
  }
  const credentials: Credentials = { old, target, plan }
  if (
    Buffer.byteLength(
      JSON.stringify(
        { ...plan, phase: 'credentials-staged', credentialsSha: 'a'.repeat(64) },
        null,
        2
      )
    ) > 4096
  )
    refuse()
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
        hash(`${JSON.stringify(targetConfig(staged), null, 2)}\n`) !== staged.plan.targetStamp ||
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
      switchInventory(dir, staged.plan.external, true)
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
            'external',
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
        switchInventory(dir, record.external, true)
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
    if (
      hash(`${JSON.stringify(targetConfig(credentials), null, 2)}\n`) !== record.targetStamp ||
      JSON.stringify({
        ...credentials.plan,
        phase: record.phase,
        credentialsSha: record.credentialsSha,
      }) !== JSON.stringify(record)
    )
      refuse()
    validateExternalPlan(credentials)
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
    switchInventory(dir, record.external, true)
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
    if (record.external) {
      rebindPrepared(dir, record.external, check)
      afterWrite('ledger-bound-written')
    } else if (!record.keepLedger)
      for (const suffix of ['', '-wal', '-shm']) {
        check()
        rmSync(join(stateFolder(dir), `state.db${suffix}`), { force: true })
      }
    phase('ledger-retired')
  }
  if (record.phase === 'ledger-retired') {
    check()
    writeOwnedJson(dir, 'config.json', targetConfig(credentials), check)
    afterWrite('active-connection-written')
    if (record.external?.targetDescriptor) {
      writeOwnedJson(
        dir,
        ACTIVATION_FILE,
        targetActivation(record.external.targetDescriptor),
        check
      )
      afterWrite('activation-written')
    }
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

function targetActivation(descriptor: LocalDescriptor) {
  return {
    format: 'abele.external.activation',
    schema: 1,
    state: 'active',
    ledgerFile: 'state.db',
    descriptor,
  }
}
function targetConfig(credentials: Credentials): unknown {
  const descriptor = credentials.plan.external?.targetDescriptor
  return descriptor
    ? { format: 'abele.cli', schema: 2, connection: credentials.target, descriptor }
    : credentials.target
}
function validateExternalSwitch(external: ExternalSwitch): void {
  ConnectionBindingSchema.parse(external.oldBinding)
  ConnectionBindingSchema.parse(external.targetBinding)
  if (
    typeof external.keepEntries !== 'boolean' ||
    Object.keys(external).some(
      (key) =>
        ![
          'oldBinding',
          'targetBinding',
          'targetDescriptor',
          'oldActivationSha',
          'keepEntries',
        ].includes(key)
    )
  )
    refuse()
  if (external.targetDescriptor) {
    const descriptor = parseLocalDescriptor(external.targetDescriptor)
    if (
      !sameConnection(descriptor.binding, external.targetBinding) ||
      Object.keys(external.targetDescriptor).some(
        (key) => !['ledgerId', 'instanceId', 'binding'].includes(key)
      ) ||
      !/^[a-f0-9]{64}$/.test(external.oldActivationSha ?? '')
    )
      refuse()
  } else if (external.oldActivationSha !== null) refuse()
}
function validateExternalPlan(credentials: Credentials): void {
  const external = credentials.plan.external
  if (!external) return
  validateExternalSwitch(external)
  if (
    !credentials.old ||
    !sameConnection(
      external.oldBinding,
      personalBinding(credentials.old, external.oldBinding.generation)
    ) ||
    !sameConnection(
      external.targetBinding,
      personalBinding(credentials.target, external.oldBinding.generation + 1)
    )
  )
    refuse()
  if (
    external.targetDescriptor &&
    !sameConnection(external.targetDescriptor.binding, external.targetBinding)
  )
    refuse()
  if (
    external.keepEntries &&
    (normalizeServerUrl(credentials.old.serverUrl) !==
      normalizeServerUrl(credentials.target.serverUrl) ||
      credentials.old.vaultId !== credentials.target.vaultId)
  )
    refuse()
}
function switchInventory(
  dir: string,
  external: ExternalSwitch | null | undefined,
  recoveringSwitch: boolean
): void {
  if (!external) {
    assertLocalSafety(dir, true, true, false, false, recoveringSwitch)
    return
  }
  validateExternalSwitch(external)
  assertPreparedInventory(
    dir,
    'state.db',
    [external.oldBinding, external.targetBinding],
    recoveringSwitch
  )
  const file = join(stateFolder(dir), ACTIVATION_FILE)
  if (external.targetDescriptor) {
    if (!existsSync(file)) refuse()
    const stamp = hash(readEvidence(file, 16384))
    const target = hash(`${JSON.stringify(targetActivation(external.targetDescriptor), null, 2)}\n`)
    if (stamp !== external.oldActivationSha && stamp !== target) refuse()
    const stat = lstatSync(join(stateFolder(dir), 'state.db'))
    const db = new SqliteDatabase(join(stateFolder(dir), 'state.db'), {
      readonly: true,
      fileMustExist: true,
    })
    try {
      const row = db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get('daemon:ledger-instance-id') as { value: string } | undefined
      if (!stat.isFile() || row?.value !== external.targetDescriptor.instanceId) refuse()
    } finally {
      db.close()
    }
  } else if (existsSync(file)) refuse()
}
/** Deliberate empty-inventory transition, not a bootstrap or token-rotation shortcut.
 * It uses the bound physical database and one SQLite transaction. Any ambiguous COMMIT
 * stops this invocation; only a reopened connection may resolve the recorded old/target.
 */
function rebindPrepared(dir: string, external: ExternalSwitch, check: () => void): void {
  check()
  const db = new SqliteDatabase(join(stateFolder(dir), 'state.db'), { fileMustExist: true })
  let committing = false
  try {
    db.exec('BEGIN IMMEDIATE')
    const get = (key: string) =>
      (
        db.prepare('SELECT value FROM meta WHERE key = ?').get(`daemon:${key}`) as
          { value: string } | undefined
      )?.value
    const doc = decodeExternalDocument(get('external-files') ?? '')
    if (sameConnection(doc.binding, external.targetBinding)) {
      db.exec('ROLLBACK')
      return
    }
    if (
      !sameConnection(doc.binding, external.oldBinding) ||
      doc.files.length ||
      doc.operations.length
    )
      refuse()
    const ready = JSON.parse(get(READY_KEY) ?? '') as {
      binding: ConnectionBinding
      revision: number
    }
    if (!sameConnection(ready.binding, external.oldBinding) || ready.revision !== doc.revision)
      refuse()
    if (!external.keepEntries) {
      check()
      db.exec("DELETE FROM entries; DELETE FROM meta WHERE key <> 'daemon:ledger-instance-id'")
    }
    const put = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    put.run(
      'daemon:external-files',
      JSON.stringify({ ...doc, binding: external.targetBinding, revision: doc.revision + 1 })
    )
    put.run(
      `daemon:${READY_KEY}`,
      JSON.stringify({ ...ready, binding: external.targetBinding, revision: doc.revision + 1 })
    )
    check()
    committing = true
    db.exec('COMMIT')
  } catch (cause) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw new ExternalStateError(committing ? 'commit-unknown' : 'aborted', { cause })
  } finally {
    db.close()
  }
}
