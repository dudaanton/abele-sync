import { expect, it } from 'vitest'
import { SyncEngine } from '../../src/engine.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { selectiveDefaults } from '../../src/selective.js'
import { sha256 } from '../../src/hash.js'
import { requestReconciliation, readReconciliation } from '../../src/reconciliation.js'
import type { EngineClient } from '../../src/engineClient.js'

it('D-012 checkpoints a completed reconciliation inspection before a later cycle failure', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  for (let n = 0; n < 40; n++) {
    const path = `${n}.md`
    await fs.writeAtomic(path, bytes, 1)
    await state.put({
      path,
      wirePath: path,
      fileId: `f${n}`,
      versionId: `v${n}`,
      sha,
      size: 1,
      mtime: 1,
    })
  }
  await state.setCursor(1)
  await requestReconciliation(state)
  let reads = 0
  const read = fs.read.bind(fs)
  fs.read = async (path) => {
    reads++
    return read(path)
  }
  const client = {
    state: async () => ({ head_seq: 1, settings: { max_file_bytes: 10000, quota_bytes: null } }),
    changes: async () => ({ items: [], next_since: 1, head_seq: 1 }),
    finishPull: async () => {
      throw new Error('late cycle failure')
    },
  } as unknown as EngineClient
  const makeEngine = () => new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  const first = makeEngine()
  await expect(first.sync()).rejects.toThrow('late cycle failure')
  expect((await readReconciliation(state))?.phase).toBe('review')
  expect(reads).toBe(40)
  const second = makeEngine()
  reads = 0
  await expect(second.sync()).rejects.toThrow('late cycle failure')
  expect(reads).toBeLessThan(40)
  await first.stop()
  await second.stop()
})
