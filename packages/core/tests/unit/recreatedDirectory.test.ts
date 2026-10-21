import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { V2Directories } from '../../src/v2Directories.js'
import type { CommitOpResult, V2CommitOp } from '@abele/sync-protocol'

it('D-021 retires an unsafe pending directory delete once and keeps ordinary sync running', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  fs.listDirectories = async function* () {
    yield { path: 'folder', identity: 'recreated', mtime: 2 }
  }
  fs.listChildren = async (parent) =>
    parent === '' ? [{ path: 'folder', kind: 'directory', identity: 'recreated' }] : []
  const pending = {
    key: 'original-key',
    op: { op: 'delete_directory', file_id: 'old-dir', base_version_id: 'old-v' },
    identity: 'old',
    localPath: 'folder',
  }
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      schemaVersion: 2,
      directories: [
        {
          file_id: 'old-dir',
          version_id: 'old-v',
          path: 'folder',
          kind: 'directory',
          mtime: 1,
          identity: 'old',
          localPath: 'folder',
        },
      ],
      pending,
      removals: [],
    })
  )
  const commit = vi.fn(async (ops: V2CommitOp[]): Promise<CommitOpResult[]> =>
    ops.map((op) => {
      if (op.op !== 'mkdir') throw new Error('must not replay a delete over recreated content')
      return {
        status: 'applied',
        file_id: 'new-dir',
        version_id: 'new-v',
        seq: 2,
        path: op.path,
        sha: null,
        size: 0,
        mtime: 2,
      }
    })
  )
  const directories = new V2Directories(fs, state, () => true, commit)
  await directories.scan()
  await directories.scan()
  expect(commit).toHaveBeenCalledTimes(1)
  expect(JSON.parse((await state.getMeta('v2-directories'))!).pending).toBeUndefined()
  expect(JSON.parse((await state.getMeta('v2-directory-review'))!)).toEqual([
    expect.objectContaining({ pending }),
  ])
})
