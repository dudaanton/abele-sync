import { expect, it, vi } from 'vitest'
import { decorateStateTransactions } from '../helpers/stateTransactions.js'
import { SyncEngine } from '../../src/engine.js'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { selectiveDefaults } from '../../src/selective.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'
import { stoppableFileEffects } from '../../src/guard.js'
import { SyncCancelled } from '../../src/cancellation.js'

it('checks stage publication and append at invocation, while allowing cleanup and explicit host work', async () => {
  const controller = new AbortController()
  let signal: AbortSignal | undefined = controller.signal
  const commit = vi.fn(async () => {}),
    append = vi.fn(async () => {}),
    discard = vi.fn(async () => {})
  const fs: FileSystem = new MemoryFileSystem()
  fs.beginAtomicWrite = async () => ({
    id: 'stage',
    offset: 0,
    commit,
    append,
    discard,
    seal: async () => {},
  })
  const port = stoppableFileEffects(fs, () => signal)
  const stage = await port.beginAtomicWrite!('file.bin', 1, null)
  controller.abort()
  await expect(stage.commit()).rejects.toBeInstanceOf(SyncCancelled)
  await expect(stage.append(0, new Uint8Array([1]))).rejects.toBeInstanceOf(SyncCancelled)
  await expect(port.writeAtomic('file.bin', new Uint8Array([1]), 1)).rejects.toBeInstanceOf(
    SyncCancelled
  )
  await stage.discard()
  expect(commit).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
  expect(discard).toHaveBeenCalledTimes(1)
  signal = undefined
  await port.writeAtomic('file.bin', new Uint8Array([2]), 1)
  expect(await port.read('file.bin')).toEqual(new Uint8Array([2]))
})

const COUNT = 33000
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
for (const phase of ['pull', 'push', 'scan', 'comparison'] as const)
  for (const verb of ['pause', 'stop'] as const)
    it(`${verb} in ${phase} drains at most one file per lane in a ${COUNT}-file inventory`, async () => {
      const fs = new MemoryFileSystem(),
        state = new MemoryStateStore()
      const content = [1, 2, 3, 4].map((n) => new Uint8Array([n]))
      const digests = await Promise.all(content.map((bytes) => sha256(bytes)))
      const blobs = new Map(digests.map((sha, n) => [sha, content[n]!]))
      const lanes = phase === 'pull' ? 4 : phase === 'push' ? 2 : 1
      const items = Array.from({ length: COUNT }, (_, n) => ({
        seq: n + 2,
        file_id: `f${n}`,
        version_id: `v${n}`,
        path: `${n}.bin`,
        sha: digests[n % digests.length]!,
        size: 1,
        mtime: 1,
        kind: 'attachment' as const,
        op: 'create' as const,
        prev_path: null,
        actor: { kind: 'system' as const, id: 'test', name: 'test' },
        at: '',
      }))
      await state.setCursor(1)
      if (phase !== 'pull')
        for (const item of items) {
          await fs.writeAtomic(item.path, blobs.get(item.sha)!, 1)
          if (phase === 'comparison')
            await state.put({
              fileId: item.file_id,
              versionId: item.version_id,
              path: item.path,
              wirePath: item.path,
              sha: item.sha,
              size: 1,
              mtime: 1,
            })
        }
      const entered = gate(),
        finishFile = gate()
      let starts = 0,
        writes = 0
      const slow = async () => {
        starts++
        if (starts === lanes) entered.release()
        await finishFile.promise
      }
      const client = {
        state: async () => ({
          head_seq: COUNT + 1,
          settings: { max_file_bytes: 1e9, quota_bytes: null },
        }),
        changes: async () => ({
          items: phase === 'pull' ? items : [],
          next_since: COUNT + 1,
          head_seq: COUNT + 1,
        }),
        getBlob: async (sha: string) => {
          await slow()
          return blobs.get(sha)!
        },
        hasBlob: async () => false,
        putBlob: async () => {
          await slow()
        },
        commitRaw: vi.fn(async () => {
          throw new Error('no commit after pause')
        }),
        subscribe: () => () => {},
      } as unknown as EngineClient
      const read = fs.read.bind(fs),
        write = fs.conditionalFile.bind(fs)
      if (phase === 'scan' || phase === 'comparison')
        fs.read = async (path) => {
          await slow()
          return read(path)
        }
      fs.conditionalFile = async (op) => {
        writes++
        return write(op)
      }
      const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
      const run = engine.sync().catch((error) => error)
      await entered.promise
      const pausedAt = performance.now()
      const stop = engine[verb]()
      const atPause = starts
      finishFile.release()
      await stop
      await run
      expect(starts).toBe(atPause)
      expect(atPause).toBe(lanes)
      expect(writes).toBe(0)
      expect(client.commitRaw).not.toHaveBeenCalled()
      expect(engine.status.state).toBe('paused')
      console.info(
        JSON.stringify({
          phase,
          verb,
          files: COUNT,
          startedLanes: atPause,
          pauseMs: performance.now() - pausedAt,
          postPauseStarts: starts - atPause,
          writes,
        })
      )
      await engine.stop()
    }, 30000)

it.each(['inspection', 'intent', 'delete-intent'] as const)(
  'pause during target %s cannot start the later filesystem write',
  async (boundary) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    await state.setCursor(1)
    const bytes = new Uint8Array([1]),
      sha = await sha256(bytes)
    if (boundary === 'delete-intent') {
      await fs.writeAtomic('a.bin', bytes, 1)
      await state.put({
        fileId: 'f',
        versionId: 'before',
        path: 'a.bin',
        wirePath: 'a.bin',
        sha,
        size: 1,
        mtime: 1,
      })
    }
    let fetched = false
    const client = {
      state: async () => ({ head_seq: 2, settings: { max_file_bytes: 100, quota_bytes: null } }),
      changes: async () => ({
        items: [
          {
            seq: 2,
            file_id: 'f',
            version_id: 'v',
            path: 'a.bin',
            sha,
            size: 1,
            mtime: 1,
            kind: 'attachment',
            op: boundary === 'delete-intent' ? 'delete' : 'create',
            prev_path: null,
            actor: { kind: 'system', id: 'test', name: 'test' },
            at: '',
          },
        ],
        next_since: 2,
        head_seq: 2,
      }),
      getBlob: async () => {
        fetched = true
        return bytes
      },
      subscribe: () => () => {},
    } as unknown as EngineClient
    const engine = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
    const stat = fs.stat.bind(fs),
      write = vi.spyOn(fs, 'conditionalFile')
    fs.stat = async (path) => {
      const result = await stat(path)
      if (fetched && boundary === 'inspection') engine.pause()
      return result
    }
    decorateStateTransactions(state, (tx) => {
      const metadata = tx.setMeta!.bind(tx)
      tx.setMeta = async (key, value) => {
        await metadata(key, value)
        if (key.startsWith('pull-base:') && boundary !== 'inspection') engine.pause()
      }
    })
    await engine.sync().catch(() => {})
    if (boundary !== 'delete-intent') expect(fetched).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(engine.status.state).toBe('paused')
    await engine.stop()
  }
)
