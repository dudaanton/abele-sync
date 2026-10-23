import { describe, expect, it } from 'vitest'
import type { ChangeItem, CommitOpResult, V2CommitOp } from '@abele/sync-protocol'
import { ExpectedWrites, pull, scan, sha256, type EngineClient } from '../../src/index.js'
import { V2Directories } from '../../src/v2Directories.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { EpochError, SimScheduler } from './scheduler.js'

describe.each([191, 192, 193, 194])(
  'directory evidence model survives every scan cut (seed %i)',
  (seed) => {
    const random = new SimScheduler(seed)
    const names = Array.from({ length: 3 }, (_, n) =>
      random.random() < 0.5 ? `Renamed${n}` : `renamed${n}`
    )
    const actions = new Map(names.map((name) => [name, Math.floor(random.random() * 4)]))
    async function execute(cut?: string) {
      const scheduler = new SimScheduler(seed)
      let fs = new MemoryStreamingFS(scheduler),
        state = new DurableStateStore(scheduler)
      // Deliberately recycle the same inode after deletion. Logical origin is an
      // oracle unavailable to core, so an unrelated candidate cannot claim a tree.
      const origins = new Map<string, 'original' | 'unrelated'>()
      const identities = new Map<string, string>()
      const instrument = () => {
        const list = fs.listDirectories.bind(fs)
        fs.listDirectories = async function* () {
          for await (const dir of list())
            yield { ...dir, identity: identities.get(dir.path) ?? 'recycled-inode' }
        }
      }
      instrument()
      const bytes = new Uint8Array([1, 2, 3]),
        sha = await sha256(bytes)
      let local = 'root',
        remote = 'root',
        deleted = false,
        remoteDeleted = false,
        seq = 1
      origins.set(local, 'original')
      await fs.writeAtomic(local + '/child.md', bytes, 1)
      await state.put({
        path: 'root/child.md',
        wirePath: 'root/child.md',
        fileId: 'child',
        versionId: 'v1',
        sha,
        size: 3,
        mtime: 1,
      })
      await state.setCursor(1)
      await state.setMeta(
        'v2-directories',
        JSON.stringify({
          directories: [
            {
              file_id: 'directory',
              version_id: 'v1',
              path: remote,
              kind: 'directory',
              mtime: 1,
              identity: 'recycled-inode',
              localPath: remote,
            },
          ],
          removals: [],
        })
      )
      const events: ChangeItem[] = [],
        receipts = new Map<string, CommitOpResult[]>()
      const commit = async (ops: V2CommitOp[], key: string): Promise<CommitOpResult[]> => {
        await scheduler.point('server.before')
        if (receipts.has(key)) return receipts.get(key)!
        const results: CommitOpResult[] = []
        for (const op of ops) {
          expect(op.op).not.toBe('mkdir') // no candidate may gain a fresh identity
          if (op.op !== 'move_directory' && op.op !== 'delete_directory')
            throw new Error('unexpected op')
          expect(op.file_id).toBe('directory')
          if (op.op === 'move_directory')
            expect(origins.get(op.to_path), 'unrelated subtree claimed').toBe('original')
          else {
            expect(deleted, `remote content deleted without local deletion cut=${cut}`).toBe(true)
            remoteDeleted = true
          }
          const previous = remote
          if (op.op === 'move_directory') remote = op.to_path
          seq++
          events.push({
            seq,
            file_id: 'child',
            version_id: `v${seq}`,
            op: op.op === 'move_directory' ? 'move' : 'delete',
            path: remote + '/child.md',
            prev_path: previous + '/child.md',
            sha: remoteDeleted ? null : sha,
            size: remoteDeleted ? null : 3,
            mtime: remoteDeleted ? null : 1,
            kind: 'note',
            actor: { kind: 'system', id: 'model', name: 'model' },
            at: '',
          })
          results.push({
            status: 'applied',
            file_id: 'directory',
            version_id: `v${seq}`,
            path: remote,
            seq,
            sha: null,
            size: 0,
            mtime: 1,
          })
        }
        receipts.set(key, results)
        await scheduler.point('server.accepted')
        return results
      }
      let directories = new V2Directories(fs, state, () => true, commit)
      const client = {
        changes: async (since: number) => ({
          items: events.filter((e) => e.seq > since),
          head_seq: seq,
          next_since: seq,
        }),
        getBlob: async () => bytes,
        pathRefusal: (path: string) => directories.refusalFor(path),
      } as unknown as EngineClient
      const points: string[] = []
      const observe = async (held: boolean) => {
        const run = async () => {
          await directories.scan()
          await pull(client, fs, state, {
            expected: new ExpectedWrites(),
            filter: { excluded: () => false },
            dirty: new Set(),
          })
          const found = await scan(fs, state, { excluded: () => false })
          expect(found.ops, 'held or already settled tree emitted file operations').toEqual([])
        }
        const start = scheduler.points.length
        scheduler.cut = cut
        try {
          await run()
        } catch (error) {
          if (!(error instanceof EpochError) || !cut) throw error
          scheduler.cut = undefined
          fs = fs.reopen()
          state = state.reopen()
          instrument()
          directories = new V2Directories(fs, state, () => true, commit)
          await run()
        }
        points.push(...scheduler.points.slice(start))
        scheduler.cut = undefined
        expect(directories.refusals().length > 0).toBe(held)
        if (held) {
          expect(directories.refusalFor(remote + '/child.md')).toBeDefined()
          expect(directories.refusalFor(local + '/child.md')).toBeDefined()
        } else if (!deleted) expect(remote).toBe(local)
      }
      // Visibility is not deletion evidence: neither a normalization collision
      // nor simultaneous loss of name, inode and relative child name ends a hold.
      await fs.moveDirectory(local, 'café')
      origins.delete(local)
      local = 'café'
      origins.set(local, 'original')
      await fs.writeAtomic(local + '/child.md', new Uint8Array([9, 8, 7]), 2)
      await observe(true)
      await fs.mkdir('cafe\u0301')
      await observe(true)
      await fs.removeDirectory('cafe\u0301')
      await fs.moveDirectory(local, 'invisible')
      origins.delete(local)
      local = 'invisible'
      origins.set(local, 'original')
      identities.set(local, 'unobserved-object')
      await fs.move(local + '/child.md', local + '/renamed.md')
      await observe(true)
      await fs.move(local + '/renamed.md', local + '/child.md')
      await fs.writeAtomic(local + '/child.md', bytes, 4)
      await observe(false)
      for (const name of names) {
        const from = local
        if (identities.has(from)) {
          identities.set(name, identities.get(from)!)
          identities.delete(from)
        }
        await fs.moveDirectory(from, name)
        origins.delete(from)
        origins.set(name, 'original')
        local = name
        await fs.writeAtomic(local + '/child.md', new Uint8Array([9, 8, 7]), 2)
        await observe(true)
        if (seed % 2 === 1) {
          // Replacing the held directory object while keeping its files does not
          // prove local deletion of the remote subtree. Remember its candidate path.
          identities.set(local, `replacement-${name}`)
          await observe(true)
          const again = local + '-again'
          identities.set(again, identities.get(local)!)
          identities.delete(local)
          await fs.moveDirectory(local, again)
          origins.delete(local)
          origins.set(again, 'original')
          local = again
          identities.set(local, `unobserved-replacement-${name}`)
          await observe(true)
        }
        if (seed % 2 === 0) {
          // Recreating the old name must not overwrite the held source's identity
          // and release either subtree to the file scanner.
          identities.set(from, 'new-inode')
          await fs.writeAtomic(from + '/unrelated.md', new Uint8Array([5]), 2)
          origins.set(from, 'unrelated')
          await observe(true)
          await fs.remove(from + '/unrelated.md')
          await fs.removeDirectory(from)
          identities.delete(from)
          origins.delete(from)
          await observe(true)
        }
        // Seeded operation choices alter the sequence, not just path spellings.
        const action = actions.get(name)!
        if (action < 2) {
          if (action === 1) await fs.remove(local + '/child.md')
          await fs.writeAtomic(local + '/child.md', new Uint8Array([4, action, 6]), 3)
        } else {
          const next = action === 2 ? local + '-random' : local.toUpperCase()
          if (identities.has(local)) {
            identities.set(next, identities.get(local)!)
            identities.delete(local)
          }
          await fs.moveDirectory(local, next)
          origins.delete(local)
          origins.set(next, 'original')
          local = next
        }
        await directories.loadRefusals(true)
        await observe(true)
        // Delete/recreate a child during the hold, including repeated observations.
        await fs.remove(local + '/child.md')
        await fs.writeAtomic(local + '/child.md', new Uint8Array([7, 8, 9]), 3)
        await observe(true)
        await fs.writeAtomic(local + '/child.md', bytes, 4)
        await observe(false)
        // A real case-only directory rename is also corroborated by the child.
        const changed = local === local.toLowerCase() ? local.toUpperCase() : local.toLowerCase()
        if (identities.has(local)) {
          identities.set(changed, identities.get(local)!)
          identities.delete(local)
        }
        await fs.moveDirectory(local, changed)
        origins.delete(local)
        origins.set(changed, 'original')
        local = changed
        await observe(false)
      }
      const recycled = identities.get(local) ?? 'recycled-inode'
      await fs.remove(local + '/child.md')
      await fs.removeDirectory(local)
      origins.delete(local)
      identities.delete(local)
      deleted = true
      local = 'unrelated'
      identities.set(local, recycled)
      await fs.writeAtomic(local + '/child.md', new Uint8Array([6, 6, 6]), 5)
      origins.set(local, 'unrelated')
      await observe(true)
      await observe(true)
      await fs.remove(local + '/child.md')
      await fs.removeDirectory(local)
      origins.delete(local)
      await observe(true)
      expect(remoteDeleted).toBe(false)
      // Absence cannot resolve this hold. Restore the original tracked tree
      // as positive evidence, settle its move, then observe an actual deletion.
      local = 'restored'
      origins.set(local, 'original')
      await fs.writeAtomic(local + '/child.md', bytes, 6)
      deleted = false
      await observe(false)
      await fs.remove(local + '/child.md')
      await fs.removeDirectory(local)
      origins.delete(local)
      deleted = true
      await observe(false)
      expect(remoteDeleted).toBe(true)
      if (cut) expect(scheduler.epoch, cut).toBe(1)
      return points
    }
    let points: string[] | undefined
    it.each(Array.from({ length: 32 }, (_, n) => n))(
      'cuts shard %i (at most 64)',
      async (shard) => {
        if (!points) {
          points = await execute()
          console.info(`directoryEvidence seed ${seed}: ${points.length} crash cuts`)
        }
        expect(points.length).toBeLessThanOrEqual(32 * 64)
        for (const cut of points.slice(shard * 64, (shard + 1) * 64)) await execute(cut)
      },
      20000
    )
  }
)
