import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, rename, rmdir, unlink, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  EngineError,
  MAX_CHUNK_BYTES,
  type AtomicStage,
  type ContentIdentity,
  type ConditionalFileOperation,
} from '@abele/sync-core'
import { containedIn, isMissing, ownTempFolder } from './nodeFsGuard.js'
import { syncParents, syncPath } from './nodeFsDurability.js'
import { restoreVictim } from './nodeConditional.js'

interface Metadata {
  id: string
  target: string
  mtime: number
  base: (ContentIdentity & { mtime?: number }) | null
  offset: number
  sealed: ContentIdentity | null
  phase: 'receiving' | 'sealed' | 'installing' | 'committed'
}
interface Host {
  fingerprint(path: string): Promise<ContentIdentity>
  conditionalFile(operation: ConditionalFileOperation): Promise<boolean>
}
const same = (a: ContentIdentity, b: ContentIdentity) => a.size === b.size && a.sha === b.sha

/** Durable journal-owned data, separate from the disposable temporary directory. */
export class NodeStages {
  private async retireBase(meta: Metadata): Promise<void> {
    const backup = await this.path(meta.id, 'base')
    let info
    try {
      info = await lstat(backup)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    this.check()
    if (
      info.isFile() &&
      meta.base &&
      same(await this.host.fingerprint(`.abele-sync/stages/${meta.id}/base`), meta.base)
    ) {
      await unlink(backup)
      await syncParents(backup, this.root)
    } else {
      await restoreVictim(this.root, `${meta.target}.sync-conflict-${meta.id}`, backup, meta.id)
    }
  }
  private readonly queues = new Map<string, Promise<unknown>>()
  constructor(
    private readonly root: string,
    private readonly host: Host,
    private readonly check: () => void,
    private readonly track: <T>(work: () => Promise<T>) => Promise<T>
  ) {}

  private async path(id: string, name: string): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new EngineError('io', 'invalid stage id')
    const path = await containedIn(this.root, `.abele-sync/stages/${id}/${name}`)
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new EngineError('conflict', 'stage is a link')
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    return path
  }
  private relative(id: string) {
    return `.abele-sync/stages/${id}/data`
  }
  private async persist(meta: Metadata, creating = false): Promise<void> {
    this.check()
    const temp = await this.path(meta.id, 'meta.next')
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
      0o600
    )
    try {
      await handle.writeFile(JSON.stringify(meta))
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.check()
    await rename(await this.path(meta.id, 'meta.next'), await this.path(meta.id, 'meta.json'))
    const file = await this.path(meta.id, 'meta.json')
    // Creation makes the entire ancestor chain durable before handing out the id.
    // Later checkpoints (including after reopen) change only this directory's entries.
    if (creating) await syncParents(file, this.root)
    else await syncPath(dirname(file))
  }
  private async load(id: string): Promise<Metadata> {
    const path = await this.path(id, 'meta.json')
    const info = await lstat(path)
    if (!info.isFile() || info.size > 16 * 1024)
      throw new EngineError('io', 'invalid stage metadata')
    const meta = JSON.parse(await readFile(path, 'utf8')) as Metadata
    if (
      meta.id !== id ||
      typeof meta.target !== 'string' ||
      !Number.isSafeInteger(meta.offset) ||
      meta.offset < 0 ||
      !Number.isFinite(meta.mtime) ||
      !['receiving', 'sealed', 'installing', 'committed'].includes(meta.phase)
    )
      throw new EngineError('io', 'invalid stage metadata')
    await containedIn(this.root, meta.target)
    return meta
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.queues.get(id) ?? Promise.resolve()
    const next = before.catch(() => {}).then(() => this.track(work))
    this.queues.set(id, next)
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id)
      })
      .catch(() => {})
    return next
  }
  async begin(
    target: string,
    mtime: number,
    base: ContentIdentity | null,
    beforeCreate?: (id: string) => Promise<void>
  ): Promise<AtomicStage> {
    return this.track(async () => {
      this.check()
      await containedIn(this.root, target)
      const folder = await ownTempFolder(this.root, '.abele-sync', 'stages', this.check)
      const id = randomBytes(16).toString('hex')
      await beforeCreate?.(id)
      this.check()
      await mkdir(join(folder, id), { mode: 0o700 })
      const handle = await open(await this.path(id, 'data'), 'wx', 0o600)
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.persist(
        { id, target, mtime, base, offset: 0, sealed: null, phase: 'receiving' },
        true
      )
      return this.reopen(id)
    })
  }
  async reopen(id: string): Promise<AtomicStage> {
    const meta = await this.load(id)
    let offset = meta.offset
    return {
      id,
      installed: async () => {
        const current = await this.load(id)
        if (!current.sealed || !['installing', 'committed'].includes(current.phase)) return false
        try {
          const [a, b] = await Promise.all([
            lstat(await this.path(id, 'data')),
            lstat(await containedIn(this.root, current.target)),
          ])
          return (
            a.dev === b.dev &&
            a.ino === b.ino &&
            same(await this.host.fingerprint(current.target), current.sealed)
          )
        } catch (error) {
          if (isMissing(error)) return false
          throw error
        }
      },
      get offset() {
        return offset
      },
      append: (at, bytes, signal) =>
        this.serial(id, async () => {
          signal?.throwIfAborted()
          this.check()
          const current = await this.load(id)
          if (
            current.phase !== 'receiving' ||
            at !== current.offset ||
            !bytes.length ||
            bytes.length > MAX_CHUNK_BYTES ||
            bytes.buffer.byteLength > MAX_CHUNK_BYTES
          )
            throw new EngineError('io', 'invalid contiguous stage append')
          const handle = await open(
            await this.path(id, 'data'),
            constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
          )
          try {
            // Bytes beyond the durable checkpoint are an interrupted append, never accepted data.
            if ((await handle.stat()).size < current.offset)
              throw new EngineError('io', 'truncated stage')
            this.check()
            await handle.truncate(current.offset)
            let written = 0
            while (written < bytes.length) {
              signal?.throwIfAborted()
              this.check()
              const result = await handle.write(
                bytes,
                written,
                bytes.length - written,
                at + written
              )
              if (!result.bytesWritten) throw new EngineError('io', 'stage write made no progress')
              written += result.bytesWritten
            }
            await handle.sync()
          } finally {
            await handle.close()
          }
          current.offset += bytes.length
          await this.persist(current)
          offset = current.offset
        }),
      seal: (expected) =>
        this.serial(id, async () => {
          this.check()
          const current = await this.load(id)
          if (
            current.offset !== expected.size ||
            !same(await this.host.fingerprint(this.relative(id)), expected)
          )
            throw new EngineError('conflict', 'stage size or digest mismatch')
          if (current.phase === 'committed' && current.sealed && same(current.sealed, expected))
            return
          if (current.phase === 'installing' && current.sealed && same(current.sealed, expected))
            return
          this.check()
          const data = await this.path(id, 'data')
          const stats = await lstat(data)
          await utimes(data, stats.atime, current.mtime / 1000)
          await syncPath(data)
          current.sealed = expected
          current.phase = 'sealed'
          await this.persist(current)
        }),
      commit: (signal) =>
        this.serial(id, async () => {
          signal?.throwIfAborted()
          this.check()
          const current = await this.load(id)
          if (!current.sealed || current.phase === 'receiving')
            throw new EngineError('conflict', 'stage is not sealed')
          if (!same(await this.host.fingerprint(this.relative(id)), current.sealed))
            throw new EngineError('conflict', 'sealed stage changed')
          const data = await this.path(id, 'data')
          const backup = await this.path(id, 'base')
          let target = await containedIn(this.root, current.target)
          this.check()
          await mkdir(dirname(target), { recursive: true })
          target = await containedIn(this.root, current.target)
          const statOrNull = async (path: string) => {
            try {
              return await lstat(path)
            } catch (error) {
              if (isMissing(error)) return null
              throw error
            }
          }
          // A link installed before the crash is publication evidence, not a user's edit.
          const sourceInfo = await lstat(data)
          const named = await statOrNull(target)
          if (
            (current.phase === 'installing' || current.phase === 'committed') &&
            named?.dev === sourceInfo.dev &&
            named.ino === sourceInfo.ino
          ) {
            if (!same(await this.host.fingerprint(current.target), current.sealed))
              throw new EngineError('conflict', 'published stage was edited')
            // Publication may have crashed before flushing its new name. The committed
            // checkpoint must never become durable ahead of the recovered target.
            await syncParents(target, this.root)
            await this.retireBase(current)
            current.phase = 'committed'
            await this.persist(current)
            return
          }
          if (current.phase === 'committed')
            throw new EngineError('conflict', 'published stage was replaced by a local save')
          current.phase = 'installing'
          await this.persist(current)
          // Upgrade recovery of an older adapter's already-displaced base.
          const legacyBase =
            named === null &&
            current.base !== null &&
            (await statOrNull(backup)) !== null &&
            same(await this.host.fingerprint(`.abele-sync/stages/${id}/base`), current.base)
          if (
            !(await this.host.conditionalFile({
              path: current.target,
              expected:
                current.base === null || legacyBase
                  ? null
                  : {
                      ...current.base,
                      mtime: current.base.mtime ?? Math.max(0, Math.round(named?.mtimeMs ?? 0)),
                    },
              effect: { kind: 'install', stageId: id },
            }))
          )
            throw new EngineError('conflict', 'stage target changed; displaced bytes preserved')
          await syncParents(target, this.root)
          await this.retireBase(current)
          current.phase = 'committed'
          await this.persist(current)
        }),
      discard: () => this.discard(id),
    }
  }
  discard(id: string): Promise<void> {
    return this.serial(id, async () => {
      this.check()
      // Apply the same policy to a legacy adapter's displaced base.
      try {
        await lstat(await this.path(id, 'base'))
        await this.retireBase(await this.load(id))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
      for (const name of ['data', 'meta.next', 'meta.json']) {
        this.check()
        await unlink(await this.path(id, name)).catch((error) => {
          if (!isMissing(error)) throw error
        })
      }
      this.check()
      await rmdir(dirname(await this.path(id, 'data'))).catch((error) => {
        if (!isMissing(error)) throw error
      })
      // Only the established stages directory lost an entry; its ancestors did not.
      await syncPath(dirname(dirname(await this.path(id, 'data')))).catch((error) => {
        if (!isMissing(error)) throw error
      })
    })
  }
}
