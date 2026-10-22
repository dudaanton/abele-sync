import { transact } from './stateTransaction.js'
import type { ChangeItem } from '@abele/sync-protocol'
import type { StateStore } from './state.js'
import type { EngineClient } from './engineClient.js'
import { GENERATION_KEY } from './restoreGeneration.js'

export const HELD_PROGRESS = 'pull-held-progress'
const PREFIX = 'pull-held:'
export const pullHoldKey = (id: string) => PREFIX + encodeURIComponent(id)
export interface HeldChange {
  change: ChangeItem
  base: string | null
  firstSeq: number
}
interface Node extends HeldChange {
  next: string | null
}
interface Header {
  format: 2
  generation: string | null
  head: number
  inventoryComplete: boolean
  first: string | null
  last: string | null
}
interface LegacyHeader {
  generation: string | null
  head: number
  inventoryComplete: boolean
  holds: HeldChange[]
}

/** A durable linked index: a changed hold touches at most itself and one neighbor.
 * No metadata enumeration capability is required from the host. */
export class PullHolds {
  readonly files = new Map<string, ChangeItem>()
  readonly records = new Map<string, Node>()
  header: Header | null = null
  private first: string | null = null
  private last: string | null = null
  private readonly previous = new Map<string, string | null>()
  private readonly changed = new Set<string>()
  private heap: { id: string; seq: number }[] = []
  private generation: string | null = null
  private readonly paths = new Map<string, Set<string>>()

  private indexPath(change: ChangeItem): void {
    let ids = this.paths.get(change.path)
    if (!ids) this.paths.set(change.path, (ids = new Set()))
    ids.add(change.file_id)
  }

  private forgetPath(change: ChangeItem): void {
    const ids = this.paths.get(change.path)
    ids?.delete(change.file_id)
    if (ids?.size === 0) this.paths.delete(change.path)
  }

  constructor(
    private readonly state: StateStore,
    private readonly progressKey = HELD_PROGRESS,
    private readonly key = pullHoldKey
  ) {}

  async load(): Promise<void> {
    this.generation = (await this.state.getMeta?.(GENERATION_KEY)) ?? null
    const raw = JSON.parse((await this.state.getMeta?.(this.progressKey)) ?? 'null') as
      Header | LegacyHeader | null
    if (raw === null || raw.generation !== this.generation) return
    const originalHead = raw.head
    // The first array format accidentally filed reached=0 during inventory.
    // Its inventory checkpoint still has the authoritative snapshot head.
    if (!raw.inventoryComplete && raw.head === 0) {
      const checkpoint = JSON.parse(
        (await this.state.getMeta?.('pull-manifest-progress')) ?? 'null'
      ) as { head: number; generation?: string | null } | null
      if (checkpoint !== null && (checkpoint.generation ?? null) === this.generation)
        raw.head = checkpoint.head
    }
    if ('holds' in raw) {
      for (const held of raw.holds) this.put(held)
      await transact(this.state, async (tx) => {
        await this.persist(raw.head, raw.inventoryComplete, tx)
      })
      return
    }
    this.header = raw
    this.first = raw.first
    this.last = raw.last
    let previous: string | null = null
    for (let id = raw.first; id !== null;) {
      if (this.records.has(id)) throw new Error('cyclic pull hold index')
      const value = await this.state.getMeta?.(this.key(id))
      if (value == null) throw new Error('missing durable pull hold')
      const node = JSON.parse(value) as Node
      this.records.set(id, node)
      this.files.set(id, node.change)
      this.indexPath(node.change)
      this.previous.set(id, previous)
      this.push({ id, seq: node.firstSeq })
      previous = id
      id = node.next
    }
    if (previous !== raw.last) throw new Error('invalid pull hold tail')
    if (raw.head !== originalHead)
      await transact(this.state, (tx) => this.persist(raw.head, raw.inventoryComplete, tx))
  }

  put(held: HeldChange): void {
    const id = held.change.file_id,
      old = this.records.get(id)
    if (old !== undefined) {
      if (held.change.seq < old.change.seq) return
      const firstSeq = Math.min(old.firstSeq, held.firstSeq)
      if (old.change === held.change && old.base === held.base && old.firstSeq === firstSeq) return
      this.forgetPath(old.change)
      this.records.set(id, { ...held, firstSeq, next: old.next })
      if (firstSeq !== old.firstSeq) this.push({ id, seq: firstSeq })
    } else {
      if (this.last !== null) {
        this.records.get(this.last)!.next = id
        this.changed.add(this.last)
      } else this.first = id
      this.previous.set(id, this.last)
      this.last = id
      this.records.set(id, { ...held, next: null })
      this.push({ id, seq: held.firstSeq })
    }
    this.files.set(id, held.change)
    this.indexPath(held.change)
    this.changed.add(id)
  }

  setBase(id: string, base: string | null): void {
    const held = this.records.get(id)
    if (held !== undefined && held.base !== base) {
      held.base = base
      this.changed.add(id)
    }
  }

  resolve(change: ChangeItem): void {
    const id = change.file_id,
      held = this.records.get(id)
    if (held === undefined || held.change.seq > change.seq) return
    const previous = this.previous.get(id) ?? null
    if (previous !== null) {
      this.records.get(previous)!.next = held.next
      this.changed.add(previous)
    } else this.first = held.next
    if (held.next !== null) this.previous.set(held.next, previous)
    else this.last = previous
    this.previous.delete(id)
    this.forgetPath(held.change)
    this.records.delete(id)
    this.files.delete(id)
    this.changed.add(id)
    // Bound the lazy minimum index even when an old hold pins a long-lived run.
    if (this.heap.length > this.records.size * 2 + 1024) {
      this.heap = []
      for (const [key, node] of this.records) this.push({ id: key, seq: node.firstSeq })
    }
  }

  earliest(): number | null {
    while (this.heap.length) {
      const top = this.heap[0]!
      if (this.records.get(top.id)?.firstSeq === top.seq) return top.seq
      const last = this.heap.pop()!
      if (!this.heap.length) break
      this.heap[0] = last
      let at = 0
      for (;;) {
        const left = at * 2 + 1,
          right = left + 1
        let next = at
        if (left < this.heap.length && this.heap[left]!.seq < this.heap[next]!.seq) next = left
        if (right < this.heap.length && this.heap[right]!.seq < this.heap[next]!.seq) next = right
        if (next === at) break
        ;[this.heap[at], this.heap[next]] = [this.heap[next]!, this.heap[at]!]
        at = next
      }
    }
    return null
  }

  /** A newer successfully settled identity at a path supersedes its historical occupants. */
  resolvePath(change: ChangeItem): void {
    for (const id of this.paths.get(change.path) ?? []) {
      const held = this.records.get(id)!
      if (held.change.seq <= change.seq) this.resolve(held.change)
    }
  }

  private push(value: { id: string; seq: number }): void {
    let at = this.heap.length
    this.heap.push(value)
    while (at > 0) {
      const parent = (at - 1) >>> 1
      if (this.heap[parent]!.seq <= value.seq) break
      this.heap[at] = this.heap[parent]!
      at = parent
    }
    this.heap[at] = value
  }

  /** Caller owns the cursor transaction. Changed keys are a constant-size patch. */
  async persist(
    head: number,
    inventoryComplete: boolean,
    tx: StateStore = this.state
  ): Promise<void> {
    for (const id of this.changed) {
      const node = this.records.get(id)
      await tx.setMeta?.(this.key(id), node === undefined ? null : JSON.stringify(node))
    }
    this.header =
      this.first === null && inventoryComplete
        ? null
        : {
            format: 2,
            generation: this.generation,
            head,
            inventoryComplete,
            first: this.first,
            last: this.last,
          }
    await tx.setMeta?.(this.progressKey, this.header === null ? null : JSON.stringify(this.header))
    this.changed.clear()
  }
}

/** Legacy inventory holds must become independent before a rewind removes inventory. */
export async function importLegacyPullHolds(
  state: StateStore,
  client?: EngineClient
): Promise<void> {
  // Upgrade array records even when inventory has no embedded holds. load() still
  // needs the inventory keys to repair a zero head before a rewind can clear them.
  const raw = JSON.parse((await state.getMeta?.(HELD_PROGRESS)) ?? 'null') as
    Header | LegacyHeader | null
  const legacy = JSON.parse((await state.getMeta?.('pull-manifest-progress')) ?? 'null') as {
    generation?: string | null
    head: number
    coverageComplete?: boolean
    firstHeld?: number | null
    heldChanges?: ChangeItem[]
  } | null
  const valid =
    legacy !== null &&
    (legacy.generation ?? null) === ((await state.getMeta?.(GENERATION_KEY)) ?? null)
  const payload = (
    valid ? JSON.parse((await state.getMeta?.('pull-manifest-page')) ?? '{}') : {}
  ) as {
    heldChanges?: ChangeItem[]
  }
  const changes: ChangeItem[] = [
    ...(valid ? (legacy.heldChanges ?? []) : []),
    ...(payload.heldChanges ?? []),
  ]
  const pointer =
    valid && legacy.firstHeld != null && changes.length === 0 ? legacy.firstHeld : null
  const array = raw !== null && 'holds' in raw
  const repair = raw !== null && raw.head === 0 && !raw.inventoryComplete && valid
  if (!array && !repair && !changes.length && pointer === null) return
  const holds = new PullHolds(state)
  await holds.load()
  if (!valid) return
  // The first format stored only a sequence barrier. Its unresolved files can
  // belong to earlier inventory pages, so recover their metadata from the feed.
  if (pointer !== null) {
    if (client === undefined) throw new Error('legacy hold recovery requires a feed client')
    let since = Math.max(0, pointer - 1)
    while (since < legacy.head) {
      const page = await client.changes(since, 1000)
      for (const change of page.items)
        if (change.seq >= pointer && change.seq <= legacy.head) changes.push(change)
      if (page.next_since <= since) throw new Error('legacy hold recovery feed made no progress')
      since = page.next_since
    }
    if (!changes.length) throw new Error('legacy held changes unavailable; retain checkpoint')
  }
  if (!changes.length) return
  for (const change of changes) {
    const existing = holds.records.get(change.file_id)
    holds.put({
      change: existing !== undefined && existing.change.seq > change.seq ? existing.change : change,
      base:
        existing !== undefined
          ? existing.base
          : ((await state.byFileId(change.file_id))?.versionId ?? null),
      firstSeq: Math.min(change.seq, existing?.firstSeq ?? change.seq),
    })
  }
  await transact(state, async (tx) => {
    await holds.persist(
      Math.min(holds.header?.head ?? legacy.head, legacy.head),
      holds.header?.inventoryComplete ?? legacy.coverageComplete ?? false,
      tx
    )
    await tx.setMeta?.(
      'pull-manifest-progress',
      JSON.stringify({ ...legacy, firstHeld: null, heldChanges: undefined })
    )
    await tx.setMeta?.('pull-manifest-page', JSON.stringify({ ...payload, heldChanges: [] }))
  })
}
