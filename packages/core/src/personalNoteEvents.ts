import { z } from 'zod'
import { PathSchema, ShaSchema, type ChangeItem } from '@abele/sync-protocol'
import type { VaultClient } from './client.js'
import type { StateStore } from './state.js'
import type { FileSystem } from './fs.js'
import { sha256 } from './hash.js'
import { EngineError } from './errors.js'
const id = z.string().min(1).max(200)
const DeliverySchema = z
  .object({
    deliveryId: z.string().min(1).max(500),
    fileId: id,
    versionId: id,
    path: PathSchema,
    sha: ShaSchema,
    size: z.number().int().nonnegative(),
    source: z.literal('personal'),
    automatic: z.literal('enabled'),
  })
  .strict()
export type PersonalNoteDelivery = z.infer<typeof DeliverySchema>
export type PersonalNoteHook = (
  event: PersonalNoteDelivery,
  exactBytes: Uint8Array
) => Promise<void>
export function personalNoteDelivery(change: ChangeItem): PersonalNoteDelivery {
  if (change.kind !== 'note' || change.sha === null || change.size === null)
    throw new EngineError('protocol', 'not a personal note delivery')
  return DeliverySchema.parse({
    deliveryId: `${change.file_id}:${change.version_id}`,
    fileId: change.file_id,
    versionId: change.version_id,
    path: change.path,
    sha: change.sha,
    size: change.size,
    source: 'personal',
    automatic: 'enabled',
  })
}
const Schema = z
    .object({
      binding: z
        .object({ issuer: z.string(), vaultId: z.string(), credentialFingerprint: z.string() })
        .strict(),
      events: z.array(DeliverySchema).max(1000),
    })
    .strict(),
  KEY = 'personal-note-cache-events'
/** One optional personal-note/cache bridge, not a script execution/trust engine.
 * Sharedness and arrival timing never disable automations. Native cache/version
 * correspondence still comes from the host's independently verified adapter.
 */
export class PersonalNoteEvents {
  private constructor(
    private readonly state: StateStore,
    private readonly fs: FileSystem,
    private readonly binding: z.infer<typeof Schema>['binding']
  ) {}
  static async open(client: VaultClient, state: StateStore, fs: FileSystem) {
    if (!state.getMeta || !state.setMeta)
      throw new EngineError('io', 'personal note events need durable metadata')
    const binding = await client.ownerPublicationIdentity(),
      inbox = new PersonalNoteEvents(state, fs, binding)
    await inbox.read()
    return inbox
  }
  private async read() {
    const raw = await this.state.getMeta!(KEY)
    if (raw === null) return { binding: this.binding, events: [] as PersonalNoteDelivery[] }
    if (raw.length > 2 * 1024 * 1024)
      throw new EngineError('io', 'personal note event bound exceeded')
    const parsed = Schema.safeParse(JSON.parse(raw))
    if (!parsed.success || JSON.stringify(parsed.data.binding) !== JSON.stringify(this.binding))
      throw new EngineError('lost', 'personal note event binding needs recovery')
    return parsed.data
  }
  private async save(events: PersonalNoteDelivery[]) {
    const value = Schema.parse({ binding: this.binding, events }),
      raw = JSON.stringify(value)
    if (raw.length > 2 * 1024 * 1024)
      throw new EngineError('io', 'personal note event bound exceeded')
    await this.state.setMeta!(KEY, raw)
  }
  async record(input: PersonalNoteDelivery, bytes: Uint8Array) {
    const event = DeliverySchema.parse(input)
    if (
      event.deliveryId !== `${event.fileId}:${event.versionId}` ||
      bytes.length !== event.size ||
      (await sha256(bytes)) !== event.sha
    )
      throw new EngineError('protocol', 'personal note delivery integrity mismatch')
    const current = await this.state.byFileId(event.fileId)
    if (
      !current ||
      current.versionId !== event.versionId ||
      current.wirePath !== event.path ||
      current.sha !== event.sha
    )
      throw new EngineError('lost', 'note delivery is not the recorded personal version')
    const stored = await this.read(),
      events = stored.events.filter((old) => old.fileId !== event.fileId)
    if (events.length >= 1000)
      throw new EngineError('io', 'personal note event count bound reached')
    events.push(event)
    await this.save(events)
  }
  async deliver(
    cache: { fileId: string; versionId: string; path: string; sha: string },
    run: (event: PersonalNoteDelivery) => Promise<void>
  ): Promise<boolean> {
    return this.state.transaction(async () => {
      const stored = await this.read(),
        event = stored.events.find(
          (row) =>
            row.fileId === cache.fileId &&
            row.versionId === cache.versionId &&
            row.path === cache.path &&
            row.sha === cache.sha
        )
      if (!event) return false
      const current = await this.state.byFileId(event.fileId)
      if (
        !current ||
        current.versionId !== event.versionId ||
        current.wirePath !== event.path ||
        current.sha !== event.sha
      )
        return false
      let bytes: Uint8Array
      try {
        bytes = await this.fs.read(current.path)
      } catch {
        return false
      }
      if (bytes.length !== event.size || (await sha256(bytes)) !== event.sha) return false
      await run(event)
      // At-least-once with stable deliveryId; host side effects must deduplicate.
      await this.save(
        (await this.read()).events.filter((row) => row.deliveryId !== event.deliveryId)
      )
      return true
    })
  }
}
