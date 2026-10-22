import {
  MemoryStateStore,
  type StateStore,
  type StateEntry,
  type Journal,
} from '../../src/state.js'
import { SimScheduler } from './scheduler.js'

/** Durable process image plus revocable private patches. A cursor commit must not
 * clone the whole inventory: that makes the simulator itself quadratic. */
export class DurableStateStore implements StateStore {
  readonly transactionScoped = true
  private active = true
  private readonly epoch: number
  constructor(
    private readonly scheduler: SimScheduler,
    private readonly disk = { state: new MemoryStateStore() },
    private readonly view: StateStore = disk.state
  ) {
    this.epoch = scheduler.epoch
  }
  reopen(): DurableStateStore {
    return new DurableStateStore(this.scheduler, this.disk)
  }
  private async access<T>(label: string, fn: (state: StateStore) => T | Promise<T>): Promise<T> {
    if (!this.active) throw new Error('expired transaction epoch')
    await this.scheduler.point(`state.${label}`, this.epoch)
    const result = await fn(this.view)
    this.scheduler.fence(this.epoch)
    return result
  }
  get(path: string) {
    return this.access('get', (s) => s.get(path))
  }
  byFileId(id: string) {
    return this.access('byFileId', (s) => s.byFileId(id))
  }
  async *all() {
    const entries = await this.access('all', async (s) => {
      const entries: StateEntry[] = []
      for await (const entry of s.all()) entries.push(entry)
      return entries
    })
    yield* entries
  }
  put(entry: StateEntry) {
    return this.access('put', (s) => s.put(entry))
  }
  delete(path: string) {
    return this.access('delete', (s) => s.delete(path))
  }
  getCursor() {
    return this.access('getCursor', (s) => s.getCursor())
  }
  setCursor(seq: number) {
    return this.access('setCursor', (s) => s.setCursor(seq))
  }
  getJournal() {
    return this.access('getJournal', async (s) => structuredClone(await s.getJournal()))
  }
  setJournal(journal: Journal | null) {
    return this.access('setJournal', (s) => s.setJournal(structuredClone(journal)))
  }
  getMeta(key: string) {
    return this.access('getMeta', (s) => s.getMeta!(key))
  }
  setMeta(key: string, value: string | null) {
    return this.access('setMeta', (s) => s.setMeta!(key, value))
  }
  metadataKeys(prefix: string) {
    return this.access('metadataKeys', (s) => s.metadataKeys!(prefix))
  }
  async transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T> {
    await this.scheduler.point('state.begin', this.epoch)
    if (!this.active) throw new Error('expired transaction epoch')
    return this.view.transaction(async (view) => {
      const tx = new DurableStateStore(this.scheduler, this.disk, view)
      try {
        const result = await fn(tx)
        await this.scheduler.point('state.commit', this.epoch)
        return result
      } finally {
        tx.active = false
      }
    })
  }
}
