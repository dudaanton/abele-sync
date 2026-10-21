import { expect, it } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { scan } from '../../src/scanner.js'
import { push } from '../../src/pusher.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'

it('D-034 discards every prefetched receipt stage when paused during the first publication', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  for (let n = 0; n < 2; n++) await fs.writeAtomic(`${n}.md`, new Uint8Array([n]), 1)
  const found = await scan(fs, state, { excluded: () => false })
  const controller = new AbortController(),
    active = new Set<string>(),
    discarded: string[] = []
  const bodies = [new Uint8Array([3]), new Uint8Array([4])]
  const shas = await Promise.all(bodies.map((b) => sha256(b)))
  let allocated = 0
  fs.beginAtomicWrite = async (path, mtime) => {
    const id = `stage-${allocated++}`
    active.add(id)
    let data = new Uint8Array()
    return {
      id,
      get offset() {
        return data.length
      },
      append: async (_at, bytes) => {
        data = new Uint8Array([...data, ...bytes])
      },
      seal: async () => {},
      commit: async () => {
        await fs.writeAtomic(path, data, mtime)
        controller.abort()
      },
      discard: async () => {
        discarded.push(id)
        active.delete(id)
      },
    }
  }
  fs.reopenStage = async () => {
    throw new Error('not a replay')
  }
  const client = {
    hasBlob: async () => true,
    commitRaw: async () => ({
      replayed: false,
      body: {
        head_seq: 2,
        results: shas.map((sha, n) => ({
          status: 'merged',
          file_id: `f${n}`,
          version_id: `v${n}`,
          seq: n + 1,
          path: `${n}.md`,
          sha,
          size: 1,
          mtime: 2,
        })),
      },
    }),
    openVersion: async (file: string) => {
      const bytes = bodies[Number(file.slice(1))]!
      return {
        size: 1,
        read: async () => bytes,
        assertUnchanged: async () => {},
        close: async () => {},
      }
    },
  } as unknown as EngineClient
  await expect(
    push(client, fs, state, found, { expected: new ExpectedWrites(), signal: controller.signal })
  ).rejects.toMatchObject({ code: 'offline' })
  expect(allocated).toBe(2)
  expect([...active]).toEqual([])
  expect(discarded.sort()).toEqual(['stage-0', 'stage-1'])
  expect(await state.get('0.md')).toMatchObject({ versionId: 'v0' })
  expect(await state.getJournal()).not.toBeNull()
})
