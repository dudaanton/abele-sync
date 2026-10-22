import { EngineError } from './errors.js'
import type { Journal, StateEntry, StateStore } from './state.js'

export type StateMutation =
  | { kind: 'put'; entry: StateEntry }
  | { kind: 'delete'; path: string }
  | { kind: 'cursor'; value: number }
  | { kind: 'journal'; value: Journal | null }
  | { kind: 'meta'; key: string; value: string | null }

/** Private, revocable read-your-writes capability. Hosts publish its patch atomically,
 * without awaits, after checking that the root has not changed since creation.
 * Reads are read-committed; an intervening root write makes commit fail conservatively.
 * No root mutation or database transaction is held across the user's awaits. */
export class StateTransaction implements StateStore {
  readonly transactionScoped = true
  readonly mutations: StateMutation[] = []
  private active = true
  private entries = new Map<string, StateEntry | null>()
  private ids = new Map<string, string>()
  private wirePaths = new Map<string, string>()
  private meta = new Map<string, string | null>()
  private cursor: number | undefined
  private journal: { value: Journal | null } | undefined

  constructor(
    private readonly parent: StateStore,
    /** Hosts with unique fileId/wirePath rows supply indexed clash lookup. */
    private readonly clashes?: (entry: StateEntry) => Promise<StateEntry[]>
  ) {}
  close(): void {
    this.active = false
  }
  private check(): void {
    if (!this.active) throw new EngineError('conflict', 'state transaction capability has expired')
  }
  effectOwner(): string | undefined {
    this.check()
    return this.parent.effectOwner?.()
  }
  async get(path: string): Promise<StateEntry | null> {
    this.check()
    const entry = this.entries.has(path) ? this.entries.get(path)! : await this.parent.get(path)
    return entry === null ? null : { ...entry }
  }
  async byFileId(id: string): Promise<StateEntry | null> {
    this.check()
    const path = this.ids.get(id)
    const entry = path === undefined ? await this.parent.byFileId(id) : await this.get(path)
    if (entry === null) return null
    const current = await this.get(entry.path)
    return current?.fileId === id ? current : null
  }
  async *all(): AsyncIterable<StateEntry> {
    this.check()
    for await (const entry of this.parent.all()) {
      this.check()
      if (!this.entries.has(entry.path)) yield entry
    }
    for (const entry of this.entries.values()) {
      this.check()
      if (entry !== null) yield { ...entry }
    }
  }
  async put(entry: StateEntry): Promise<void> {
    this.check()
    if (this.clashes) {
      for (const clash of await this.findClashes(entry)) {
        this.check()
        if (clash.path !== entry.path) this.apply({ kind: 'delete', path: clash.path })
      }
    }
    const copy = { ...entry }
    this.entries.set(copy.path, copy)
    this.ids.set(copy.fileId, copy.path)
    this.wirePaths.set(copy.wirePath, copy.path)
    this.mutations.push({ kind: 'put', entry: copy })
  }
  async delete(path: string): Promise<void> {
    this.check()
    this.entries.set(path, null)
    this.mutations.push({ kind: 'delete', path })
  }
  async getCursor(): Promise<number> {
    this.check()
    return this.cursor ?? this.parent.getCursor()
  }
  async setCursor(value: number): Promise<void> {
    this.check()
    this.cursor = value
    this.mutations.push({ kind: 'cursor', value })
  }
  async getJournal(): Promise<Journal | null> {
    this.check()
    return cloneJournal(
      this.journal === undefined ? await this.parent.getJournal() : this.journal.value
    )
  }
  async setJournal(journal: Journal | null): Promise<void> {
    this.check()
    const value = cloneJournal(journal)
    this.journal = { value }
    this.mutations.push({ kind: 'journal', value })
  }
  async getMeta(key: string): Promise<string | null> {
    this.check()
    return this.meta.has(key) ? this.meta.get(key)! : ((await this.parent.getMeta?.(key)) ?? null)
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    this.check()
    this.meta.set(key, value)
    this.mutations.push({ kind: 'meta', key, value })
  }
  async metadataKeys(prefix: string): Promise<string[]> {
    this.check()
    const keys = new Set(await this.parent.metadataKeys?.(prefix))
    for (const [key, value] of this.meta)
      if (key.startsWith(prefix)) {
        if (value === null) keys.delete(key)
        else keys.add(key)
      }
    return [...keys]
  }
  async transaction<T>(work: (tx: StateStore) => Promise<T>): Promise<T> {
    this.check()
    const version = this.mutations.length
    const child = new StateTransaction(
      this,
      this.clashes ? (entry) => this.findClashes(entry) : undefined
    )
    try {
      const result = await work(child)
      this.check()
      if (version !== this.mutations.length) throw changedState()
      for (const op of child.mutations) this.apply(op)
      return result
    } finally {
      child.close()
    }
  }
  private apply(op: StateMutation): void {
    switch (op.kind) {
      case 'put':
        this.entries.set(op.entry.path, op.entry)
        this.ids.set(op.entry.fileId, op.entry.path)
        this.wirePaths.set(op.entry.wirePath, op.entry.path)
        break
      case 'delete':
        this.entries.set(op.path, null)
        break
      case 'cursor':
        this.cursor = op.value
        break
      case 'journal':
        this.journal = { value: op.value }
        break
      case 'meta':
        this.meta.set(op.key, op.value)
        break
    }
    this.mutations.push(op)
  }
  private async findClashes(entry: StateEntry): Promise<StateEntry[]> {
    const paths = new Set((await this.clashes!(entry)).map((e) => e.path))
    for (const path of [this.ids.get(entry.fileId), this.wirePaths.get(entry.wirePath)])
      if (path !== undefined) paths.add(path)
    const found: StateEntry[] = []
    for (const path of paths) {
      const current = await this.get(path)
      if (current && (current.fileId === entry.fileId || current.wirePath === entry.wirePath))
        found.push(current)
    }
    return found
  }
}

const cloneJournal = (value: Journal | null): Journal | null =>
  value === null ? null : structuredClone(value)
export const changedState = () =>
  new EngineError('conflict', 'state changed outside the transaction; retry')

const legacyQueue = new WeakMap<StateStore, Promise<unknown>>()
/** A per-record savepoint inside an existing transaction, including legacy hosts.
 * Failed work never publishes its patch into the surrounding transaction. */
export async function savepoint<T>(
  state: StateStore,
  work: (tx: StateStore) => Promise<T>
): Promise<T> {
  const patch = new StateTransaction(state)
  try {
    const result = await work(patch)
    for (const op of patch.mutations) {
      switch (op.kind) {
        case 'put':
          await state.put(op.entry)
          break
        case 'delete':
          await state.delete(op.path)
          break
        case 'cursor':
          await state.setCursor(op.value)
          break
        case 'journal':
          await state.setJournal(op.value)
          break
        case 'meta':
          await state.setMeta!(op.key, op.value)
          break
      }
    }
    return result
  } finally {
    patch.close()
  }
}
/** Compatibility for old callback-without-argument stores. Serialize engine transactions
 * and use the captured store only if the host has not advertised scoped support.
 * Legacy hosts MUST reserve exclusive root-store access for the entire callback; this
 * fallback cannot isolate writes made directly by another host task. Concurrent hosts
 * must implement transactionScoped and pass a distinct handle (never the root store). */
export function transact<T>(state: StateStore, work: (tx: StateStore) => Promise<T>): Promise<T> {
  const run = () =>
    state.transaction((tx) => {
      if (state.transactionScoped && (!tx || tx === state))
        throw new EngineError(
          'protocol',
          'scoped state store did not provide a transaction capability'
        )
      return tx === undefined ? legacyWork(state, work) : work(tx)
    })
  if (state.transactionScoped) return run()
  const previous = legacyQueue.get(state) ?? Promise.resolve()
  const operation = previous.then(run, run)
  legacyQueue.set(
    state,
    operation.then(
      () => undefined,
      () => undefined
    )
  )
  return operation
}

async function legacyWork<T>(state: StateStore, work: (tx: StateStore) => Promise<T>): Promise<T> {
  let active = true
  const check = () => {
    if (!active) throw new EngineError('conflict', 'state transaction capability has expired')
  }
  const view = new Proxy(state, {
    get(target, key) {
      if (key === 'transactionScoped') return true
      // Nested work remains inside the legacy host's one exclusive transaction.
      if (key === 'transaction')
        return async <T>(nested: (tx: StateStore) => Promise<T>) => {
          check()
          return legacyWork(target, nested)
        }
      const value: unknown = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      if (key === 'all')
        return async function* () {
          check()
          for await (const entry of target.all()) {
            check()
            yield entry
          }
        }
      return (...args: unknown[]) => {
        // Most StateStore methods return promises; preserve sync optional metadata methods.
        if (!active)
          return Promise.reject(
            new EngineError('conflict', 'state transaction capability has expired')
          )
        return value.apply(target, args)
      }
    },
  })
  try {
    return await work(view)
  } finally {
    active = false
  }
}
