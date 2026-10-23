import { AbeleError } from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'
import { isFinalForBatch } from './commitErrors.js'
import { afterStateCommit, transact } from './stateTransaction.js'

export type RetryPhase = 'pull' | 'push' | 'scan' | 'recovery'
export interface WaitingFile {
  path: string
  phase: RetryPhase
  attempts: number
  nextAt: number
  reason: string
  quarantined: boolean
  local?: boolean
  /** Durable recovery obligation; scheduling alone is never an owner. */
  owner?: string
  attempt?: string
}
/** Bind backoff to an immutable outgoing intent, not future files at its pathname. */
export const retryAttempt = (op: object): string => JSON.stringify(op, Object.keys(op).sort())
const PREFIX = 'file-retry:'
const key = (path: string) => PREFIX + encodeURIComponent(path)

/** Only filesystem-port errors are tagged: a database or network failure must
 * never be mistaken for a failure confined to a file. */
export class FileOperationError extends Error {
  constructor(
    readonly path: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
export function isFileFailure(error: unknown): boolean {
  return (
    error instanceof FileOperationError || (error instanceof AbeleError && isFinalForBatch(error))
  )
}

/** Scheduling metadata only. PullHolds/refusals retain incoming obligations and
 * the journal retains uncertain commits; this table never advances a cursor. */
export class FileRetries {
  private rows = new Map<string, WaitingFile>()
  constructor(
    private readonly state: StateStore,
    private readonly now: () => number,
    private readonly log: (line: string) => void
  ) {}
  async load(): Promise<void> {
    const rows = new Map<string, WaitingFile>()
    for (const name of (await this.state.metadataKeys?.(PREFIX)) ?? []) {
      const raw = await this.state.getMeta?.(name)
      if (raw !== null && raw !== undefined) {
        let row: WaitingFile
        try {
          row = JSON.parse(raw) as WaitingFile
          if (
            !row ||
            typeof row.path !== 'string' ||
            (row.owner !== undefined && typeof row.owner !== 'string') ||
            key(row.path) !== name ||
            !['pull', 'push', 'scan', 'recovery'].includes(row.phase) ||
            !Number.isSafeInteger(row.attempts) ||
            row.attempts < 1 ||
            !Number.isFinite(row.nextAt) ||
            typeof row.quarantined !== 'boolean' ||
            typeof row.reason !== 'string'
          )
            throw new Error('invalid file retry record')
        } catch {
          // Parse/shape only: store reads above must still propagate I/O failures.
          let path = name
          try {
            path = decodeURIComponent(name.slice(PREFIX.length))
          } catch {
            /* keep the record id */
          }
          row = {
            path,
            phase: 'recovery',
            attempts: 1,
            nextAt: 0,
            reason: `invalid retry metadata: ${name}`,
            quarantined: true,
          }
        }
        rows.set(row.path, row)
      }
    }
    const owners = [...rows.values()].some((row) => row.phase === 'recovery')
      ? await this.recoveryOwners()
      : new Map<string, string>()
    for (const row of rows.values()) {
      if (row.phase !== 'recovery' || row.reason.startsWith('invalid retry metadata: ')) continue
      const owner = row.owner ?? owners.get(row.path)
      if (!owner || !owners.has(owner)) {
        await this.state.setMeta?.(key(row.path), null)
        rows.delete(row.path)
      } else row.owner = owner
    }
    this.rows = rows
  }
  private async recoveryOwners(): Promise<Map<string, string>> {
    const owners = new Map<string, string>()
    for (const prefix of ['push-receipt:', 'pull-write:', 'pull-evict:']) {
      for (const name of (await this.state.metadataKeys?.(prefix)) ?? []) {
        const raw = await this.state.getMeta?.(name)
        if (raw == null) continue
        owners.set(name, name)
        let value
        try {
          value = JSON.parse(raw)
        } catch {
          /* damaged records still own their review */
        }
        for (const path of [value?.path, value?.wirePath, value?.base?.wirePath])
          if (typeof path === 'string') owners.set(path, name)
        if (prefix !== 'push-receipt:') {
          const entry = await this.state.byFileId(name.slice(prefix.length))
          if (entry) owners.set(entry.wirePath, name)
        }
      }
    }
    return owners
  }
  list(): WaitingFile[] {
    return [...this.rows.values()].map((row) => ({ ...row }))
  }
  /** Server refusals are conditional on the policy and membership we observed.
   * A changed policy/head is new evidence, not another attempt against the same
   * failure. Local I/O and recovery backoff must survive these changes. */
  async refreshServerPolicy(limits: string, head: number): Promise<void> {
    const oldLimits = await this.state.getMeta?.('retry-policy-limits')
    const oldHead = await this.state.getMeta?.('retry-policy-head')
    for (const row of this.list()) {
      if (row.phase !== 'push' || row.local) continue
      const code = row.reason.split(':', 1)[0]
      const changedLimits = oldLimits !== limits && ['too_large', 'quota_exceeded'].includes(code!)
      const changedHead =
        oldHead !== String(head) &&
        ['quota_exceeded', 'leaves_scope', 'forbidden', 'not_found', 'path_taken'].includes(code!)
      // Uncommitted uploads can free quota without advancing the feed. The wire
      // contract explicitly permits quota_waiting to be asked again next cycle.
      if (code === 'quota_waiting' || changedLimits || changedHead)
        await this.succeeded(row.path, 'push')
    }
    await this.state.setMeta?.('retry-policy-limits', limits)
    await this.state.setMeta?.('retry-policy-head', String(head))
  }
  has(path: string, phase?: RetryPhase): boolean {
    const row = this.rows.get(path)
    return row !== undefined && (!phase || row.phase === phase)
  }
  ready(path: string, phase?: RetryPhase, attempt?: string): boolean {
    const target = path
    for (;;) {
      const row = this.rows.get(path)
      const otherDirection =
        row?.phase === 'push' &&
        !row.local &&
        (phase === 'pull' ||
          phase === 'scan' ||
          (path === target &&
            attempt !== undefined &&
            row.attempt !== undefined &&
            attempt !== row.attempt))
      if (row && !otherDirection && (row.quarantined || row.nextAt > this.now())) return false
      const at = path.lastIndexOf('/')
      if (at < 0) return true
      path = path.slice(0, at)
    }
  }
  async next(): Promise<number | null> {
    let next: number | null = null
    let owners: Map<string, string> | undefined
    for (const row of this.rows.values())
      if (!row.quarantined) {
        if (row.phase === 'recovery') {
          owners ??= await this.recoveryOwners()
          const owner = row.owner ?? owners.get(row.path)
          if (!owner || !owners.has(owner)) continue
        }
        next = Math.min(next ?? row.nextAt, row.nextAt)
      }
    return next
  }
  async failed(
    path: string,
    phase: RetryPhase,
    error: unknown,
    quarantine = false,
    state = this.state,
    owner?: string,
    attempt?: string
  ): Promise<void> {
    // Multiple phases can see the same failed path in one cycle; count one attempt.
    const prior = this.rows.get(path)
    if (prior?.phase === 'recovery' && phase !== 'recovery') return
    const changedAttempt =
      attempt !== undefined && prior?.attempt !== undefined && attempt !== prior.attempt
    if (prior && prior.phase === phase && !changedAttempt && !this.ready(path)) return
    const attempts = (changedAttempt ? 0 : (prior?.attempts ?? 0)) + 1
    const row: WaitingFile = {
      path,
      phase,
      attempts,
      nextAt: this.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)),
      reason: error instanceof Error ? error.message : String(error),
      quarantined: quarantine || (phase === 'recovery' && attempts >= 3),
      local: error instanceof FileOperationError,
      ...((owner ?? prior?.owner) ? { owner: owner ?? prior?.owner } : {}),
      ...(attempt === undefined ? {} : { attempt }),
    }
    if (!state.setMeta || !state.metadataKeys) throw error
    const persist = async (tx: StateStore) => {
      await tx.setMeta!(key(path), JSON.stringify(row))
      afterStateCommit(tx, () => {
        this.rows.set(path, row)
        this.log(
          `sync: ${path} waiting: ${row.reason}${row.quarantined ? ' (recovery review)' : ''}`
        )
      })
    }
    if (state === this.state) await transact(state, persist)
    else await persist(state)
  }
  async succeeded(path: string, phase?: RetryPhase, state = this.state): Promise<void> {
    const row = this.rows.get(path)
    if (
      !row ||
      (phase && row.phase !== phase && !(phase === 'pull' && row.phase === 'push' && !row.local))
    )
      return
    const persist = async (tx: StateStore) => {
      await tx.setMeta?.(key(path), null)
      afterStateCommit(tx, () => {
        if (this.rows.get(path) === row) this.rows.delete(path)
      })
    }
    if (state === this.state) await transact(state, persist)
    else await persist(state)
  }
  async retryNow(): Promise<void> {
    await this.load()
    for (const row of this.rows.values()) {
      if (row.reason.startsWith('invalid retry metadata: ')) {
        const raw = await this.state.getMeta?.(key(row.path))
        if (raw) await this.state.setMeta!(`file-retry-review:${encodeURIComponent(row.path)}`, raw)
        // A damaged schedule is not a recovery operation. Retire it after
        // archiving instead of creating an ownerless, immediately due job.
        await this.state.setMeta!(key(row.path), null)
        this.rows.delete(row.path)
        continue
      }
      row.nextAt = 0
      row.quarantined = false
      await this.state.setMeta!(key(row.path), JSON.stringify(row))
    }
  }
}

/** Preserve port signatures and distinguish local file I/O from shared state I/O. */
export function fileErrors(fs: FileSystem): FileSystem {
  const methods = new Set([
    'read',
    'stat',
    'writeAtomic',
    'conditionalFile',
    'move',
    'remove',
    'openRead',
    'fingerprint',
    'fileIdentity',
    'beginAtomicWrite',
    'reopenStage',
    'installedFile',
    'discardInstallation',
    'mkdir',
    'removeDirectory',
    'moveDirectory',
  ])
  const callbackErrors = new WeakSet<object>()
  const rethrow = (path: string, error: unknown, file = true): never => {
    if (error && typeof error === 'object' && callbackErrors.has(error)) throw error
    // HTTP forbidden is cycle-level; a filesystem port's refusal names one file.
    // Directory policy has its own durable inbox and must retain the envelope.
    if (file && error instanceof AbeleError && error.code === 'forbidden')
      throw new FileOperationError(path, error)
    let cause = error
    for (let depth = 0; cause && depth < 8; depth++) {
      const code = (cause as { code?: string }).code
      if (['EIO', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EBUSY', 'ETXTBSY'].includes(code ?? ''))
        throw new FileOperationError(path, error)
      cause = (cause as { cause?: unknown }).cause
    }
    throw error
  }
  const port = (target: object, path: string): object =>
    new Proxy(target, {
      get(object, key) {
        const value = Reflect.get(object, key)
        if (typeof value !== 'function') return value
        if (key === 'chunks')
          return async function* (...args: unknown[]) {
            try {
              yield* value.apply(object, args)
            } catch (error) {
              rethrow(path, error)
            }
          }
        return async (...args: unknown[]) => {
          try {
            return await value.apply(object, args)
          } catch (error) {
            rethrow(path, error)
          }
        }
      },
    })
  return new Proxy(fs, {
    get(target, name) {
      const value = Reflect.get(target, name)
      if (typeof value !== 'function') return value
      if (!methods.has(String(name))) return value.bind(target)
      return async (...args: unknown[]) => {
        const first = args[0]
        const path = typeof first === 'string' ? first : ((first as { path?: string })?.path ?? '')
        if (name === 'beginAtomicWrite' && typeof args[3] === 'function') {
          const beforeCreate = args[3] as (id: string) => Promise<void>
          args[3] = async (id: string) => {
            try {
              await beforeCreate(id)
            } catch (error) {
              if (error && typeof error === 'object') callbackErrors.add(error)
              throw error
            }
          }
        }
        try {
          const result = await value.apply(target, args)
          return result && ['openRead', 'beginAtomicWrite', 'reopenStage'].includes(String(name))
            ? port(result, path)
            : result
        } catch (error) {
          rethrow(
            path,
            error,
            !['mkdir', 'moveDirectory', 'removeDirectory'].includes(String(name))
          )
        }
      }
    },
  })
}
