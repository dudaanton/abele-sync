import { z } from 'zod'
import {
  ScopedCheckpointSchema,
  ScopedCommitRequestSchema,
  PathSchema,
  ShaSchema,
  type ScopedCheckpoint,
} from '@abele/sync-protocol'
import { EngineError } from './errors.js'
import type { StateStore, StateEntry } from './state.js'
import {
  ScopedConnectionSchema,
  sameScopedConnection,
  type ScopedConnection,
} from './scopedIdentity.js'
const id = z.string().min(1).max(200)
export const ScopedJournalSchema = z
  .object({
    kind: z.literal('scoped'),
    binding: ScopedConnectionSchema,
    request_id: id,
    ops: ScopedCommitRequestSchema.shape.ops,
    startedAt: z.string().datetime(),
    phase: z.enum(['prepared', 'staged']).optional(),
    sources: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative().max(31),
            sourcePath: PathSchema,
            stagedPath: PathSchema,
            sha: ShaSchema,
            size: z.number().int().nonnegative().safe(),
            mtime: z.number().int().nonnegative().safe(),
            base: z
              .object({
                path: PathSchema,
                wirePath: PathSchema,
                fileId: id,
                versionId: id,
                sha: ShaSchema,
                size: z.number().int().nonnegative().safe(),
                mtime: z.number().int().nonnegative().safe(),
              })
              .strict()
              .nullable(),
          })
          .strict()
      )
      .max(32)
      .optional(),
  })
  .strict()
export type ScopedJournal = z.infer<typeof ScopedJournalSchema>
/** Reserved for scope exclusion and future offload: never synonymous with delete. */
export const ScopedKnownFileSchema = z
  .object({
    file_id: id,
    version_id: id,
    path: PathSchema,
    sha: ShaSchema,
    size: z.number().int().nonnegative().safe(),
    mtime: z.number().int().nonnegative().safe(),
    state: z.enum(['materialized', 'known_not_materialized', 'detached', 'held', 'deleted']),
    dirty: z.boolean(),
    /** Proven local scoped creation outcome, never inferred from matching bytes. */
    native: z.boolean().optional(),
  })
  .strict()
export type ScopedKnownFile = z.infer<typeof ScopedKnownFileSchema>
const RootSchema = z
  .object({
    binding: ScopedConnectionSchema,
    checkpoint: ScopedCheckpointSchema.nullable(),
    journal: ScopedJournalSchema.nullable(),
    known_ids: z.array(id).max(100000),
  })
  .strict()
type Root = z.infer<typeof RootSchema>
const ROOT = 'scoped-v4-state',
  knownKey = (fileId: string) => `scoped-v4-file:${fileId}`
const lost = () => new EngineError('lost', 'scoped ledger requires explicit bound recovery')
const queues = new WeakMap<StateStore, Promise<unknown>>()
function serial<T>(store: StateStore, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(store) ?? Promise.resolve()).then(fn, fn)
  queues.set(
    store,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}
/** Separate tagged metadata; the personal cursor and journal are never reused. */
export class ScopedState {
  private constructor(
    private readonly store: StateStore,
    readonly binding: ScopedConnection
  ) {}
  static async open(
    store: StateStore,
    input: unknown,
    options: { initialize?: boolean } = {}
  ): Promise<ScopedState> {
    if (!store.getMeta || !store.setMeta) throw lost()
    const parsed = ScopedConnectionSchema.safeParse(input)
    if (!parsed.success) throw lost()
    const state = new ScopedState(store, Object.freeze(parsed.data))
    await serial(store, () =>
      store.transaction(async () => {
        const raw = await store.getMeta!(ROOT)
        if (raw === null) {
          if (
            !options.initialize ||
            (await store.getCursor()) !== 0 ||
            (await store.getJournal()) !== null
          )
            throw lost()
          for await (const _entry of store.all()) throw lost()
          await store.setMeta!(
            ROOT,
            JSON.stringify({
              binding: state.binding,
              checkpoint: null,
              journal: null,
              known_ids: [],
            })
          )
        }
        await state.read()
      })
    )
    return state
  }
  private async read(): Promise<Root> {
    const raw = await this.store.getMeta!(ROOT)
    if (
      raw === null ||
      raw.length > 8 * 1024 * 1024 ||
      (await this.store.getCursor()) !== 0 ||
      (await this.store.getJournal()) !== null
    )
      throw lost()
    let root: Root
    try {
      root = RootSchema.parse(JSON.parse(raw))
    } catch {
      throw lost()
    }
    if (
      !sameScopedConnection(root.binding, this.binding) ||
      (root.journal && !sameScopedConnection(root.journal.binding, this.binding))
    )
      throw lost()
    return root
  }
  private async update<T>(fn: (root: Root) => Promise<T>): Promise<T> {
    return serial(this.store, () =>
      this.store.transaction(async () => {
        const root = await this.read(),
          result = await fn(root),
          body = JSON.stringify(root)
        if (body.length > 8 * 1024 * 1024)
          throw new EngineError('io', 'scoped ledger bound reached')
        await this.store.setMeta!(ROOT, body)
        return result
      })
    )
  }
  async getCheckpoint(): Promise<ScopedCheckpoint | null> {
    return (await this.read()).checkpoint
  }
  async setCheckpoint(input: unknown): Promise<void> {
    const parsed = ScopedCheckpointSchema.nullable().safeParse(input)
    if (!parsed.success)
      throw new EngineError('protocol', 'scoped checkpoint must be tagged opaque progress')
    await this.update(async (root) => {
      root.checkpoint = parsed.data
    })
  }
  async getJournal(): Promise<ScopedJournal | null> {
    return (await this.read()).journal
  }
  async setJournal(input: unknown): Promise<void> {
    const parsed = ScopedJournalSchema.nullable().safeParse(input)
    if (
      !parsed.success ||
      (parsed.data && !sameScopedConnection(parsed.data.binding, this.binding))
    )
      throw lost()
    await this.update(async (root) => {
      root.journal = parsed.data
    })
  }
  async finishPush(): Promise<void> {
    await this.update(async (root) => {
      root.checkpoint = null
      root.journal = null
    })
  }
  async getKnown(fileId: string): Promise<ScopedKnownFile | null> {
    const root = await this.read()
    if (!root.known_ids.includes(fileId)) return null
    return this.readKnown(fileId)
  }
  private async readKnown(fileId: string): Promise<ScopedKnownFile> {
    const raw = await this.store.getMeta!(knownKey(fileId))
    try {
      const parsed = ScopedKnownFileSchema.parse(JSON.parse(raw ?? ''))
      if (parsed.file_id !== fileId) throw lost()
      return parsed
    } catch {
      throw lost()
    }
  }
  async putKnown(input: unknown): Promise<void> {
    const parsed = ScopedKnownFileSchema.safeParse(input)
    if (!parsed.success) throw new EngineError('protocol', 'invalid scoped materialization record')
    const file = parsed.data
    await this.update(async (root) => {
      if (file.native === undefined && root.known_ids.includes(file.file_id))
        file.native = (await this.readKnown(file.file_id)).native
      if (!root.known_ids.includes(file.file_id)) {
        if (root.known_ids.length >= 100000)
          throw new EngineError('io', 'scoped inventory bound reached')
        root.known_ids.push(file.file_id)
      }
      await this.store.setMeta!(knownKey(file.file_id), JSON.stringify(file))
    })
  }
  async knownPage(offset = 0, limit = 1000): Promise<ScopedKnownFile[]> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new EngineError('protocol', 'invalid local inventory page')
    return serial(this.store, async () => {
      const root = await this.read(),
        out: ScopedKnownFile[] = []
      for (const fileId of root.known_ids.slice(offset, offset + limit))
        out.push(await this.readKnown(fileId))
      return out
    })
  }
  /** Bound facade used only by the shared guarded placement algorithm. It cannot
   * access a personal cursor/journal, and placement intents have their own namespace.
   */
  placementStore(): StateStore {
    const owner = this,
      store = this.store,
      deny = async () => {
        throw new EngineError('protocol', 'personal progress is unavailable on scoped state')
      }
    return {
      get: async (path) => {
        await owner.read()
        return store.get(path)
      },
      byFileId: async (id) => {
        await owner.read()
        return store.byFileId(id)
      },
      all: async function* () {
        await owner.read()
        yield* store.all()
      },
      put: async (entry) => {
        await owner.read()
        await store.put(entry)
      },
      delete: async (path) => {
        await owner.read()
        await store.delete(path)
      },
      getCursor: deny,
      setCursor: deny,
      getJournal: deny,
      setJournal: deny,
      transaction: async (fn) => {
        await owner.read()
        return store.transaction(fn)
      },
      getMeta: async (key) => {
        await owner.read()
        return store.getMeta!(`scoped-placement:${key}`)
      },
      setMeta: async (key, value) => {
        await owner.read()
        await store.setMeta!(`scoped-placement:${key}`, value)
      },
    }
  }
  async getEntry(path: string): Promise<StateEntry | null> {
    await this.read()
    return this.store.get(path)
  }
}
