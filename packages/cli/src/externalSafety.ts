import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import {
  decodeExternalDocument,
  decodePullIntent,
  EngineError,
  ExternalState,
  ExternalStateError,
  RecoveryBarrier,
  sameConnection,
  ScopedJournalSchema,
  ScopedKnownFileSchema,
  type ConnectionBinding,
} from '@abele/sync-core'
import { ChangeItemSchema, CommitOpSchema, validatePath } from '@abele/sync-protocol'
import {
  parseLocalDescriptor,
  personalBinding,
  readConfig,
  readConfigDescriptor,
  stateFolder,
  writeOwnedJson,
  writeVersionedConfig,
  type DaemonConfig,
  type LocalDescriptor,
} from './config.js'
import { SqliteStateStore } from './sqliteState.js'
import { liveDaemonIdentity, lockIdentity } from './lock.js'
import { assertIndexedProjectionSafety, inspectProjectionInventory } from './externalDiscovery.js'
export { inspectProjectionInventory } from './externalDiscovery.js'

export const ACTIVATION_FILE = 'external-activation.json'
export const SWITCH_FILE = 'external-connection-switch.json'
function hold(why: string): never {
  const error = new ExternalStateError('recovery-required')
  error.message = `external files require recovery: ${why}; connection and recovery data were preserved`
  throw error
}
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return hold(`unreadable ${file}`)
  }
}

// Core's durable staging also contains synthesized manifest changes: their actor
// date may be unknown ('') and an empty manifest uses sequence 0. Those are valid
// local records, not wire feed items. Keep every placement/identity field strict.
const deferredChange = ChangeItemSchema.omit({ at: true, seq: true })
function validDeferredChange(input: unknown): boolean {
  if (!input || typeof input !== 'object' || !deferredChange.safeParse(input).success) return false
  const value = input as { at?: unknown; seq?: unknown }
  return (
    typeof value.at === 'string' && Number.isSafeInteger(value.seq) && (value.seq as number) >= 0
  )
}
function journal(raw: unknown): void {
  if (!raw || typeof raw !== 'object') hold('malformed publication journal')
  const value = raw as Record<string, unknown>
  if (
    typeof value.batchId !== 'string' ||
    !value.batchId ||
    typeof value.idempotencyKey !== 'string' ||
    !value.idempotencyKey ||
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Array.isArray(value.ops) ||
    value.ops.some((op) => !CommitOpSchema.safeParse(op).success)
  )
    hold('malformed publication journal')
  for (const input of value.ops) {
    const op = CommitOpSchema.parse(input)
    if (op.op === 'create') validatePath(op.path)
    if (op.op === 'move') validatePath(op.to_path)
  }
}
/** Read-only inventory; never creates/migrates a database, identity or empty document.
 * Startup permits a valid ordinary publication journal to replay AFTER recovery;
 * retirement cannot drop that unresolved publication association.
 */
function hasRetainedFiles(path: string): boolean {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true
  return readdirSync(path).some((name) => hasRetainedFiles(join(path, name)))
}

export function assertLocalSafety(
  dir: string,
  retirement = false,
  scan = true,
  allowPullRecovery = false,
  observer = false
): void {
  const folder = stateFolder(dir)
  const scopedSources = new Set<string>()
  try {
    if (
      existsSync(folder) &&
      (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink())
    )
      hold('unsafe state directory')
    for (const name of [ACTIVATION_FILE, SWITCH_FILE])
      if (existsSync(join(folder, name))) hold(`retained ${name}`)
    for (const config of ['config.json', 'agent.json']) {
      const file = join(folder, config)
      if (existsSync(file)) {
        // Reserved versioned evidence never authorizes a legacy empty bootstrap.
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(file, 'utf8'))
        } catch {
          continue
        } // Legacy force recovery without external evidence remains supported.
        if (raw && typeof raw === 'object' && 'schema' in raw)
          hold(`versioned ${config} requires bound migration recovery`)
      }
    }
    for (const name of ['state.db', 'agent.sqlite']) {
      const file = join(folder, name)
      if (!existsSync(file)) continue
      if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
        hold(`unsafe state database ${name}`)
      const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
      try {
        for (const row of db.prepare('SELECT key, value FROM meta').all() as {
          key: string
          value: string
        }[]) {
          if (row.key === 'daemon:external-files') {
            const doc = decodeExternalDocument(row.value)
            if (doc.files.length || doc.operations.length)
              hold(`nonempty external inventory in ${name}`)
            if (name === 'state.db' && existsSync(join(folder, 'config.json'))) {
              const cfg = readConfig(dir)
              if (cfg && !sameConnection(doc.binding, personalBinding(cfg)))
                hold('foreign external binding')
            }
          }
          if (row.key.startsWith('daemon:pull-write:')) {
            const intent = decodePullIntent(row.value, row.key.slice('daemon:pull-write:'.length))
            const live =
              observer && intent.owner !== undefined && intent.owner === liveDaemonIdentity(dir)
            if (retirement || ((scan || observer) && !allowPullRecovery && !live))
              hold('unfinished pull installation intent')
          }
          if ((scan || retirement) && row.key.startsWith('daemon:scoped-placement:pull-write:'))
            hold('unfinished scoped pull installation intent')
          if (row.key === 'daemon:owner-publication-held') {
            const units = JSON.parse(row.value) as unknown
            if (!Array.isArray(units)) hold('malformed owner publication hold')
            units.forEach(journal)
            if (units.length) hold('unresolved owner publication units')
          }
          if (row.key === 'daemon:deferred-changes') {
            const pending = JSON.parse(row.value) as {
              staged?: { change: unknown; base: unknown }[]
            }
            if (
              !pending ||
              typeof pending !== 'object' ||
              (pending.staged !== undefined && !Array.isArray(pending.staged))
            )
              hold('malformed deferred queue')
            for (const item of pending.staged ?? [])
              if (
                !item ||
                !validDeferredChange(item.change) ||
                !(item.base === null || typeof item.base === 'string')
              )
                hold('malformed deferred queue')
            if (retirement && pending.staged?.length) hold('approval/deferred dependency')
          }
          if (
            retirement &&
            (row.key === 'daemon:held-deletes' || row.key === 'daemon:delete-decision')
          ) {
            const pending = JSON.parse(row.value) as unknown
            if (
              (Array.isArray(pending) && pending.length) ||
              (pending &&
                typeof pending === 'object' &&
                'fileIds' in pending &&
                (pending as { fileIds: unknown[] }).fileIds?.length)
            )
              hold('unresolved deletion decision')
          }
          if (row.key === 'journal') {
            const publication = JSON.parse(row.value) as { ownerBinding?: unknown }
            journal(publication)
            if (publication.ownerBinding && existsSync(join(folder, 'config.json'))) {
              const cfg = readConfig(dir)
              const expected = cfg && {
                issuer: personalBinding(cfg).endpoint,
                vaultId: cfg.vaultId,
                credentialFingerprint: personalBinding(cfg).credentialAssociation,
              }
              const actual = publication.ownerBinding as {
                issuer?: unknown
                vaultId?: unknown
                credentialFingerprint?: unknown
              }
              if (
                !expected ||
                actual.issuer !== expected.issuer ||
                actual.vaultId !== expected.vaultId ||
                actual.credentialFingerprint !== expected.credentialFingerprint
              )
                hold('foreign publication binding')
            }
            if (retirement) hold('unresolved publication journal')
          }
          if (row.key === 'daemon:scoped-v4-state') {
            const root = JSON.parse(row.value) as { journal?: unknown }
            if (root.journal) {
              const parsed = ScopedJournalSchema.safeParse(root.journal)
              if (!parsed.success) hold('malformed scoped publication journal')
              for (const source of parsed.data.sources ?? []) {
                if (
                  source.stagedPath !==
                  `.abele-sync/scoped-outbox/${parsed.data.request_id}/${source.index}-${source.sha}`
                )
                  hold('unbound scoped staging source')
                scopedSources.add(source.stagedPath)
              }
              if (retirement) hold('unresolved scoped publication')
            }
          }
          if (row.key.startsWith('daemon:scoped-v4-file:')) {
            const known = ScopedKnownFileSchema.parse(JSON.parse(row.value))
            if (
              retirement &&
              (known.dirty || ['detached', 'held', 'known_not_materialized'].includes(known.state))
            )
              hold('unresolved scoped placement/conflict')
          }
        }
      } finally {
        db.close()
      }
    }
    if (scan && existsSync(join(folder, 'scoped-outbox'))) {
      const inspect = (relative: string): void => {
        const path = join(dir, relative),
          stat = lstatSync(path)
        if (stat.isSymbolicLink()) hold('unsafe scoped staging artifact')
        if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(`${relative}/${name}`)
        else if (!stat.isFile() || !scopedSources.has(relative))
          hold('orphan scoped staging artifact')
      }
      inspect('.abele-sync/scoped-outbox')
    }
    if (retirement)
      for (const name of ['tmp', 'code-approvals', 'external', 'recovery', 'scoped-outbox']) {
        const path = join(folder, name)
        if (
          existsSync(path) &&
          (name === 'scoped-outbox'
            ? hasRetainedFiles(path)
            : !lstatSync(path).isDirectory() || readdirSync(path).length)
        )
          hold(`retained ${name} artifacts`)
      }
    assertIndexedProjectionSafety(dir)
  } catch (cause) {
    if (cause instanceof ExternalStateError) throw cause
    hold('unreadable ledger or local recovery evidence')
  }
}
export function assertClaim(held: () => boolean): void {
  if (!held()) throw new EngineError('lost', 'the vault lock is no longer owned here')
}
export function guardedFetch(
  fetch: typeof globalThis.fetch,
  guard: () => void
): typeof globalThis.fetch {
  return (input, init) => {
    guard()
    return fetch(input, init)
  }
}
/** Track issued effects for cooperating successor runtimes. An issued syscall/request
 * is not claimed cancellable; a successor drains it then inspects durable journals.
 */
const runtimes = new Map<string, Set<EffectFence>>()
export class EffectFence {
  readonly recovery: RecoveryBarrier
  private closed = false
  private state?: SqliteStateStore
  private fileIdentity?: string
  private instance?: string | null
  private readonly pending = new Set<Promise<unknown>>()
  private readonly predecessors: EffectFence[]
  constructor(
    readonly dir: string,
    private readonly held: (() => boolean) | undefined,
    private readonly stamp: () => string
  ) {
    this.initialStamp = stamp()
    this.key = realpathSync(dir)
    const group = runtimes.get(this.key) ?? new Set<EffectFence>()
    this.predecessors = held ? [...group] : []
    if (held) {
      group.add(this)
      runtimes.set(this.key, group)
    }
    this.recovery = new RecoveryBarrier(() => {
      this.assertOwner()
      assertLocalSafety(dir, false, false, false, !this.held)
    })
  }
  private readonly initialStamp: string
  private readonly key: string
  attach(state: SqliteStateStore, file: string): void {
    this.assertOwner()
    if (!state.isLedgerFile(file))
      hold('ledger handle no longer names the expected physical database')
    // A borrowed command must not manufacture/rotate the live owner's identity.
    this.instance = this.held ? state.getExternalInstanceId() : state.readExternalInstanceId()
    const stat = lstatSync(file)
    this.fileIdentity = `${stat.dev}:${stat.ino}`
    this.file = file
    this.state = state
  }
  private file?: string
  assertOwner = (): void => {
    if (this.closed) throw new EngineError('lost', 'runtime has been retired')
    if (this.held && !this.held()) {
      this.closed = true
      throw new EngineError('lost', 'runtime lost its vault claim')
    }
    try {
      if (this.stamp() !== this.initialStamp) throw new Error('binding changed')
      if (this.state && this.file) {
        const stat = lstatSync(this.file)
        if (
          !this.state.isLedgerFile(this.file) ||
          `${stat.dev}:${stat.ino}` !== this.fileIdentity ||
          this.state.readExternalInstanceId() !== this.instance
        )
          throw new Error('ledger replaced')
      }
    } catch {
      this.closed = true
      throw new EngineError('lost', 'connection binding, generation or ledger identity changed')
    }
  }
  assertReady = (): void => {
    this.recovery.assertReady()
  }
  effectOwner = (): string | undefined => {
    if (!this.held) return undefined
    this.assertOwner()
    return lockIdentity(this.dir)
  }
  track = <T>(work: () => Promise<T>): Promise<T> => {
    this.assertOwner()
    const promise = work()
    this.pending.add(promise)
    void promise.finally(() => this.pending.delete(promise)).catch(() => {})
    return promise
  }
  fetch(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
    return (input, init) => {
      this.assertReady()
      return this.track(() => fetch(input, init))
    }
  }
  async settlePredecessors(): Promise<void> {
    for (const previous of this.predecessors) await previous.settle()
    this.assertOwner()
  }
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
  close(): void {
    this.closed = true
    this.recovery.hold()
    if (!this.held) return
    const key = this.key
    // Retain a retired predecessor until its already-issued effects settle.
    void this.settle().then(() => {
      const group = runtimes.get(key)
      group?.delete(this)
      if (!group?.size) runtimes.delete(key)
    })
  }
}
export function personalStamp(dir: string): string {
  const cfg = readConfig(dir)
  if (!cfg) throw new EngineError('lost', 'connection configuration disappeared')
  const descriptor = readConfigDescriptor(dir)
  return JSON.stringify({
    binding: personalBinding(cfg, descriptor?.binding.generation),
    descriptor,
  })
}

interface Activation {
  format: 'abele.external.activation'
  schema: 1
  state: 'preparing' | 'active'
  ledgerFile: string
  descriptor: LocalDescriptor
}
/** Trusted future eviction preparation only; no CLI command automatically calls this API. */
export async function activateExternalFiles(
  dir: string,
  state: SqliteStateStore,
  cfg: DaemonConfig,
  held: () => boolean
): Promise<LocalDescriptor> {
  const binding = personalBinding(cfg, readConfigDescriptor(dir)?.binding.generation)
  return activateBoundExternalFiles(dir, state, binding, 'state.db', held, (descriptor, claim) =>
    writeVersionedConfig(dir, cfg, descriptor, claim)
  )
}

/** One activation protocol for both hosts/facets; descriptor writers must preserve the envelope. */
export async function activateBoundExternalFiles(
  dir: string,
  state: SqliteStateStore,
  binding: ConnectionBinding,
  ledgerFile: 'state.db' | 'agent.sqlite',
  held: () => boolean,
  writeDescriptor: (descriptor: LocalDescriptor, guard: () => void) => void
): Promise<LocalDescriptor> {
  const claim = () => {
    assertClaim(held)
    if (existsSync(join(stateFolder(dir), SWITCH_FILE))) hold(`retained ${SWITCH_FILE}`)
  }
  const file = join(stateFolder(dir), ACTIVATION_FILE)
  claim()
  state.assertExternalEffectsAllowed()
  if (
    (binding.mode === 'personal') !== (ledgerFile === 'state.db') ||
    !state.isLedgerFile(join(stateFolder(dir), ledgerFile))
  )
    hold("activation requires this vault's own ledger connection")
  let activation: Activation
  if (existsSync(file)) {
    const raw = readJson(file) as Activation
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).some(
        (key) => !['format', 'schema', 'state', 'ledgerFile', 'descriptor'].includes(key)
      )
    )
      hold('malformed activation marker')
    const descriptor = parseLocalDescriptor(raw.descriptor)
    if (
      raw.format !== 'abele.external.activation' ||
      raw.schema !== 1 ||
      !['preparing', 'active'].includes(raw.state) ||
      raw.ledgerFile !== ledgerFile ||
      state.readExternalInstanceId() !== descriptor.instanceId ||
      !sameConnection(descriptor.binding, binding)
    )
      hold('activation identity changed')
    activation = {
      format: raw.format,
      schema: raw.schema,
      state: raw.state,
      ledgerFile,
      descriptor,
    }
  } else {
    assertLocalSafety(dir, true)
    await inspectProjectionInventory(dir, { guard: claim })
    const current = await state.getExternalState()
    const existing = current === null ? null : decodeExternalDocument(current)
    if (existing && !sameConnection(existing.binding, binding)) hold('foreign external document')
    activation = {
      format: 'abele.external.activation',
      schema: 1,
      state: 'preparing',
      ledgerFile,
      descriptor: {
        ledgerId: existing?.ledgerId ?? randomUUID(),
        instanceId: state.getExternalInstanceId(),
        binding,
      },
    }
    writeOwnedJson(dir, ACTIVATION_FILE, activation, claim)
  }
  claim()
  writeDescriptor(activation.descriptor, claim)
  if (activation.state === 'active' && (await state.getExternalState()) === null)
    hold('active external journal missing')
  await ExternalState.open(state, activation.descriptor.ledgerId, activation.descriptor.binding)
  claim()
  state.assertExternalEffectsAllowed()
  writeOwnedJson(dir, ACTIVATION_FILE, { ...activation, state: 'active' }, claim)
  return activation.descriptor
}
