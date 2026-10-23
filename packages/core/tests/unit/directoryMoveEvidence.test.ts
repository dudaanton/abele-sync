import { expect, it, vi } from 'vitest'
import { MemoryFileSystem, type FileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { sha256 } from '../../src/hash.js'
import { V2Directories } from '../../src/v2Directories.js'
import type { V2CommitOp } from '@abele/sync-protocol'
import { scan } from '../../src/scanner.js'

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
    const directories = new V2Directories(fs, state, () => true, commit)
    await directories.scan()
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
    else {
      expect(ops).toEqual([])
      expect(directories.refusalFor('source/child.md')).toBeDefined()
      expect(directories.refusalFor(destination + '/child.md')).toBeDefined()
      expect((await scan(fs, state, { excluded: () => false })).ops).toEqual([])
    }
    if (mode !== 'corroborated')
      expect(JSON.parse((await state.getMeta('v2-directories'))!).directories).toContainEqual(
        source
      )
    expect(await fs.read(destination + '/child.md')).toEqual(
      mode === 'recycled' ? new Uint8Array([4, 5, 6]) : bytes
    )
    if (mode === 'recycled') {
      await fs.writeAtomic(destination + '/child.md', bytes, 2)
      await directories.scan()
      expect(ops).toContainEqual(
        expect.objectContaining({ op: 'move_directory', to_path: destination })
      )
      expect(directories.refusals()).toEqual([])
    }
  }
)

it.each([false, true])(
  'empty directory rename uses an empty-only operation (occupied=%s)',
  async (occupied) => {
    const fs: FileSystem = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const old = {
      file_id: 'old',
      version_id: 'v1',
      path: 'Empty',
      kind: 'directory',
      mtime: 1,
      identity: 'inode',
    }
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        directories: [
          old,
          ...(occupied
            ? [{ ...old, file_id: 'other', path: 'empty', identity: 'other-inode' }]
            : []),
        ],
        removals: [],
      })
    )
    await state.setCursor(1)
    fs.listDirectories = async function* () {
      yield { path: 'empty', identity: 'inode', mtime: 1 }
    }
    const ops: V2CommitOp[] = []
    await new V2Directories(
      fs,
      state,
      () => true,
      async (batch) => {
        ops.push(...batch)
        return [
          {
            status: 'applied',
            file_id: 'old',
            version_id: 'v2',
            path: occupied ? 'Empty' : 'empty',
            mtime: 1,
            seq: 2,
            sha: null,
            size: 0,
          },
        ]
      }
    ).scan()
    expect(ops).toEqual([
      occupied
        ? { op: 'delete_directory', file_id: 'old', base_version_id: 'v1', empty_only: true }
        : {
            op: 'move_directory',
            file_id: 'old',
            base_version_id: 'v1',
            to_path: 'empty',
            empty_only: true,
          },
    ])
  }
)

it('remote non-emptiness refuses an empty rename visibly and is rechecked on the next scan', async () => {
  const fs: FileSystem = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [
        {
          file_id: 'old',
          version_id: 'v1',
          path: 'old',
          kind: 'directory',
          mtime: 1,
          identity: 'inode',
        },
      ],
      removals: [],
    })
  )
  await state.setCursor(1)
  fs.listDirectories = async function* () {
    yield { path: 'new', identity: 'inode', mtime: 1 }
  }
  let empty = false
  const directories = new V2Directories(
    fs,
    state,
    () => true,
    async () =>
      empty
        ? [
            {
              status: 'applied',
              file_id: 'old',
              version_id: 'v2',
              path: 'new',
              mtime: 1,
              seq: 2,
              sha: null,
              size: 0,
            },
          ]
        : [{ status: 'rejected', code: 'conflict', message: 'directory is not empty' }]
  )
  await directories.scan()
  expect(directories.refusalFor('old/remote.md')).toBeDefined()
  expect(directories.refusalFor('new/local.md')).toBeDefined()
  empty = true
  await directories.scan()
  expect(directories.refusals()).toEqual([])
})
