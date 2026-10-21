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
  private readonly epoch: number
  private overlay: Image | undefined
  constructor(
    private readonly scheduler: SimScheduler,
    private readonly disk = { image: empty() }
  ) {
    this.epoch = scheduler.epoch
  }
  reopen(): DurableStateStore {
    return new DurableStateStore(this.scheduler, this.disk)
  }
  private async access<T>(label: string, fn: (image: Image) => T): Promise<T> {
    await this.scheduler.point(`state.${label}`, this.epoch)
    return structuredClone(fn(this.overlay ?? this.disk.image))
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
    await this.access('put', (i) => {
      i.entries = i.entries.filter((e) => e.path !== entry.path)
      i.entries.push(structuredClone(entry))
    })
  }
  async delete(path: string) {
    await this.access('delete', (i) => {
      i.entries = i.entries.filter((e) => e.path !== path)
    })
  }
  getCursor() {
    return this.access('getCursor', (i) => i.cursor)
  }
  async setCursor(seq: number) {
    await this.access('setCursor', (i) => {
      i.cursor = seq
    })
  }
  getJournal() {
    return this.access('getJournal', (i) => i.journal)
  }
  async setJournal(journal: Journal | null) {
    await this.access('setJournal', (i) => {
      i.journal = structuredClone(journal)
    })
  }
  getMeta(key: string) {
    return this.access('getMeta', (i) => i.meta.find(([k]) => k === key)?.[1] ?? null)
  }
  async setMeta(key: string, value: string | null) {
    await this.access('setMeta', (i) => {
      i.meta = i.meta.filter(([k]) => k !== key)
      if (value !== null) i.meta.push([key, value])
    })
  }
  metadataKeys(prefix: string) {
    return this.access('metadataKeys', (i) =>
      i.meta.map(([k]) => k).filter((k) => k.startsWith(prefix))
    )
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.scheduler.point('state.begin', this.epoch)
    if (this.overlay) throw new Error('nested transaction')
    this.overlay = structuredClone(this.disk.image)
    try {
      const result = await fn()
      await this.scheduler.point('state.commit', this.epoch)
      this.disk.image = this.overlay
      return result
    } finally {
      this.overlay = undefined
    }
  }
}
