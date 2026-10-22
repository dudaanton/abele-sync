import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { SyncEngine } from '../../src/engine.js'
import { selectiveDefaults } from '../../src/selective.js'
import { pull } from '../../src/puller.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import type { EngineClient } from '../../src/engineClient.js'

it('D-017 recovers an engine eviction before a missing occupant can become a local delete', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const old = new Uint8Array([1]),
    bytes = new Uint8Array([2]),
    sha = await sha256(bytes)
  await fs.writeAtomic('file.bin', old, 1)
  await state.put({
    path: 'file.bin',
    wirePath: 'file.bin',
    fileId: 'old',
    versionId: 'old-v',
    sha: await sha256(old),
    size: 1,
    mtime: 1,
  })
  await state.setCursor(1)
  const client = {
    state: async () => ({ head_seq: 1, settings: { max_file_bytes: 10000, quota_bytes: null } }),
    changes: async () => ({ items: [], next_since: 1, head_seq: 1 }),
    commitRaw: async () => {
      throw new Error('eviction must never become an outgoing delete')
    },
    getBlob: async () => bytes,
  } as unknown as EngineClient
  const initial = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  await initial.recordScope()
  await initial.stop()
  const remove = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (op) => {
    const applied = await remove(op)
    if (applied && op.effect.kind === 'remove') throw new Error('crash after eviction')
    return applied
  }
  const change: ChangeItem = {
    seq: 2,
    file_id: 'new',
    version_id: 'new-v',
    path: 'file.bin',
    prev_path: null,
    op: 'create',
    sha,
    size: 1,
    mtime: 2,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }
  await expect(
    // A new authoritative feed event can evict a clean occupant. A retained
    // staged approval cannot: it must preserve a replacement identity (D-149).
    pull(
      { ...client, changes: async () => ({ items: [change], next_since: 2, head_seq: 2 }) },
      fs,
      state,
      {
        expected: new ExpectedWrites(),
        dirty: new Set(),
        filter: { excluded: () => false },
      }
    )
  ).rejects.toThrow('crash after eviction')
  fs.conditionalFile = remove
  const restarted = new SyncEngine({ fs, state, client, selective: selectiveDefaults() })
  await restarted.sync()
  expect(await state.get('file.bin')).toBeNull()
  expect(await state.metadataKeys('pull-evict:')).toEqual([])
  await restarted.stop()
})
