import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { V2Directories } from '../../src/v2Directories.js'
import type { CommitOpResult, V2CommitOp } from '@abele/sync-protocol'

it('D-149 directory replay cannot replace a different destination identity', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const source = {
    file_id: 'A',
    version_id: 'v0',
    path: 'old',
    kind: 'directory',
    mtime: 1,
    identity: 'source',
    localPath: 'old',
  }
  const occupant = {
    ...source,
    file_id: 'B',
    version_id: 'v3',
    path: 'new',
    localPath: 'new',
    identity: 'occupant',
  }
  fs.listDirectories = async function* () {
    for (const entry of [source, occupant])
      yield { path: entry.path, identity: entry.identity, mtime: entry.mtime }
  }
  await state.setCursor(100)
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      schemaVersion: 2,
      directories: [source, occupant],
      removals: [],
      pending: {
        key: 'original',
        identity: 'source',
        localPath: 'new',
        op: { op: 'move_directory', file_id: 'A', base_version_id: 'v0', to_path: 'new' },
      },
    })
  )
  const commit = vi.fn(async (): Promise<CommitOpResult[]> => [
    {
      status: 'applied',
      file_id: 'A',
      version_id: 'v1',
      path: 'new',
      seq: 1,
      sha: null,
      size: 0,
      mtime: 1,
    },
  ])
  await new V2Directories(fs, state, () => true, commit).scan()
  const saved = JSON.parse((await state.getMeta('v2-directories'))!)
  expect(saved.directories).toEqual([source, occupant])
  expect(saved.pending).toBeUndefined()
  expect(commit).toHaveBeenCalledTimes(1)
})

it.each(['mkdir', 'move_directory', 'delete_directory'] as const)(
  'D-146 directory %s replay preserves a later identity version',
  async (kind) => {
    const fs: FileSystem = new MemoryFileSystem(),
      state = new MemoryStateStore()
    fs.listDirectories = async function* () {
      yield { path: 'new', identity: 'inode', mtime: 2 }
    }
    fs.listChildren = async (parent) =>
      parent === '' ? [{ path: 'new', identity: 'inode', kind: 'directory' }] : []
    const current = {
      file_id: 'dir',
      version_id: 'v2',
      path: 'new',
      kind: 'directory',
      mtime: 2,
      identity: 'inode',
      localPath: 'new',
    }
    const op =
      kind === 'mkdir'
        ? { op: kind, path: 'old' }
        : kind === 'move_directory'
          ? { op: kind, file_id: 'dir', base_version_id: 'v0', to_path: 'old' }
          : { op: kind, file_id: 'dir', base_version_id: 'v0' }
    await state.setCursor(2)
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        schemaVersion: 2,
        directories: [current],
        removals: [],
        pending: { key: 'original', op, identity: 'inode', localPath: 'old' },
      })
    )
    const commit = vi.fn(async (_ops: V2CommitOp[], key: string): Promise<CommitOpResult[]> => {
      if (key !== 'original') throw new Error('stale replay generated a second operation')
      return [
        {
          status: 'applied',
          file_id: 'dir',
          version_id: 'v1',
          seq: 1,
          path: 'old',
          sha: null,
          size: 0,
          mtime: 1,
        },
      ]
    })
    const directories = new V2Directories(fs, state, () => true, commit)
    await directories.scan()
    const saved = JSON.parse((await state.getMeta('v2-directories'))!)
    expect(saved.directories).toEqual([current])
    expect(saved.pending).toBeUndefined()
  }
)

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
