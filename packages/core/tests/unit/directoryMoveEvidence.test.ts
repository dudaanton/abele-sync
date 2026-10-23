import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { sha256 } from '../../src/hash.js'
import { V2Directories } from '../../src/v2Directories.js'
import type { V2CommitOp } from '@abele/sync-protocol'

it.each(['replacement', 'recycled', 'corroborated'] as const)(
  'directory rename requires corroboration (%s)',
  async (mode) => {
    const fs: FileSystem = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new Uint8Array([1, 2, 3]),
      sha = await sha256(bytes)
    const source = {
      file_id: 'source-id',
      version_id: 'v1',
      path: 'source',
      kind: 'directory',
      mtime: 1,
      identity: 'inode',
      localPath: 'source',
    }
    const target = {
      ...source,
      file_id: 'target-id',
      path: 'target',
      localPath: 'target',
      identity: 'target-inode',
    }
    const destination = mode === 'replacement' ? 'target' : 'fresh'
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        schemaVersion: 2,
        directories: mode === 'replacement' ? [source, target] : [source],
        removals: [],
      })
    )
    await state.setCursor(1)
    await state.put({
      path: 'source/child.md',
      wirePath: 'source/child.md',
      fileId: 'child',
      versionId: 'v1',
      sha,
      size: bytes.length,
      mtime: 1,
    })
    fs.listDirectories = async function* () {
      yield { path: destination, identity: 'inode', mtime: 1 }
    }
    await fs.writeAtomic(
      destination + '/child.md',
      mode === 'recycled' ? new Uint8Array([4, 5, 6]) : bytes,
      1
    )
    const ops: unknown[] = []
    const commit = vi.fn(async (batch: V2CommitOp[]) => {
      ops.push(...batch)
      return batch.map((op) => ({
        status: 'applied',
        file_id: op.op === 'mkdir' ? 'new-' + op.path : 'source-id',
        version_id: 'v2',
        path: op.op === 'mkdir' ? op.path : destination,
        mtime: 1,
        seq: 2,
      })) as never
    })
    await new V2Directories(fs, state, () => true, commit).scan()
    expect(ops).not.toContainEqual(
      expect.objectContaining({ op: 'delete_directory', file_id: 'source-id' })
    )
    if (mode === 'corroborated')
      expect(ops).toContainEqual(
        expect.objectContaining({
          op: 'move_directory',
          file_id: 'source-id',
          to_path: destination,
        })
      )
    else expect(ops).not.toContainEqual(expect.objectContaining({ op: 'move_directory' }))
    if (mode !== 'corroborated')
      expect(JSON.parse((await state.getMeta('v2-directories'))!).directories).toContainEqual(
        source
      )
    expect(await fs.read(destination + '/child.md')).toEqual(
      mode === 'recycled' ? new Uint8Array([4, 5, 6]) : bytes
    )
  }
)
