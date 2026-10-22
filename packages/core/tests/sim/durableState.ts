import { type StateStore, type StateEntry, type Journal } from '../../src/state.js'
import { SimScheduler } from './scheduler.js'

interface Image {
  entries: StateEntry[]
  cursor: number
  journal: Journal | null
  meta: [string, string][]
}
const empty = (): Image => ({ entries: [], cursor: 0, journal: null, meta: [] })

/** Process-local transaction overlay; only commit replaces the durable image. */
export class DurableStateStore implements StateStore {
  readonly transactionScoped = true
  private active = true
  private revision = 0
  private readonly epoch: number
  private overlay: Image | undefined
  constructor(
    private readonly scheduler: SimScheduler,
    private readonly disk = { image: empty(), revision: 0 }
  ) {
    this.epoch = scheduler.epoch
  }
  reopen(): DurableStateStore {
    return new DurableStateStore(this.scheduler, this.disk)
  }
  private async access<T>(label: string, fn: (image: Image) => T, write = false): Promise<T> {
    if (!this.active) throw new Error('expired transaction epoch')
    await this.scheduler.point(`state.${label}`, this.epoch)
    const result = fn(this.overlay ?? this.disk.image)
    if (write) {
      if (this.overlay) this.revision++
      else this.disk.revision++
    }
    return structuredClone(result)
  }
  get(path: string) {
    return this.access('get', (i) => i.entries.find((e) => e.path === path) ?? null)
  }
  byFileId(id: string) {
    return this.access(
      'byFileId',
      (i) =>
        i.entries
          .slice()
          .reverse()
          .find((e) => e.fileId === id) ?? null
    )
  }
  async *all() {
    for (const e of await this.access('all', (i) => i.entries)) yield e
  }
  async put(entry: StateEntry) {
    await this.access(
      'put',
      (i) => {
        i.entries = i.entries.filter((e) => e.path !== entry.path)
        i.entries.push(structuredClone(entry))
      },
      true
    )
  }
  async delete(path: string) {
    await this.access(
      'delete',
      (i) => {
        i.entries = i.entries.filter((e) => e.path !== path)
      },
      true
    )
  }
  getCursor() {
    return this.access('getCursor', (i) => i.cursor)
  }
  async setCursor(seq: number) {
    await this.access(
      'setCursor',
      (i) => {
        i.cursor = seq
      },
      true
    )
  }
  getJournal() {
    return this.access('getJournal', (i) => i.journal)
  }
  async setJournal(journal: Journal | null) {
    await this.access(
      'setJournal',
      (i) => {
        i.journal = structuredClone(journal)
      },
      true
    )
  }
  getMeta(key: string) {
    return this.access('getMeta', (i) => i.meta.find(([k]) => k === key)?.[1] ?? null)
  }
  async setMeta(key: string, value: string | null) {
    await this.access(
      'setMeta',
      (i) => {
        i.meta = i.meta.filter(([k]) => k !== key)
        if (value !== null) i.meta.push([key, value])
      },
      true
    )
  }
  metadataKeys(prefix: string) {
    return this.access('metadataKeys', (i) =>
      i.meta.map(([k]) => k).filter((k) => k.startsWith(prefix))
    )
  }
  async transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T> {
    await this.scheduler.point('state.begin', this.epoch)
    const revision = this.overlay ? this.revision : this.disk.revision
    const tx = new DurableStateStore(this.scheduler, this.disk)
    tx.overlay = structuredClone(this.overlay ?? this.disk.image)
    try {
      const result = await fn(tx)
      await this.scheduler.point('state.commit', this.epoch)
      if (revision !== (this.overlay ? this.revision : this.disk.revision))
        throw new Error('state changed outside transaction')
      if (this.overlay) {
        this.overlay = tx.overlay
        this.revision++
      } else {
        this.disk.image = tx.overlay
        this.disk.revision++
      }
      return result
    } finally {
      tx.active = false
    }
  }
}
