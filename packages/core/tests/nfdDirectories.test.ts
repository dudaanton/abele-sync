import { expect, it } from 'vitest'
import { V2Directories } from '../src/v2Directories.js'
import { MemoryFileSystem } from '../src/fs.js'
import { MemoryStateStore } from '../src/state.js'
import { validatePath, type V2CommitOp } from '@abele/sync-protocol'
import { refreshLocalPaths } from '../src/localPaths.js'
import { sha256 } from '../src/hash.js'

class DirectoryFs extends MemoryFileSystem {
  dirs = new Map<string, string>()
  async *listDirectories() {
    for (const [path, identity] of this.dirs) yield { path, identity, mtime: 1 }
  }
  async mkdir(path: string) {
    if (![...this.dirs.keys()].some((p) => p.normalize('NFC') === path.normalize('NFC')))
      this.dirs.set(path, path)
  }
}

it.each(['й', 'й'.normalize('NFD')])(
  'rebinds a replacement directory at the occupied canonical path (%s)',
  async (replacement) => {
    const fs = new DirectoryFs(),
      state = new MemoryStateStore()
    fs.dirs.set('й', 'original')
    const sent: V2CommitOp[] = []
    const dirs = new V2Directories(
      fs,
      state,
      () => true,
      async (ops) => {
        sent.push(...ops)
        return [
          { status: 'rejected', code: 'invalid_request', message: 'unexpected operation' } as never,
        ]
      }
    )
    await dirs.receive({ kind: 'directory', path: 'й', file_id: 'dir', version_id: 'v1', mtime: 1 })
    await state.setCursor(1)
    fs.dirs.delete('й')
    fs.dirs.set(replacement, 'replacement')
    await dirs.scan()
    expect(sent).toEqual([])
    expect(JSON.parse((await state.getMeta('v2-directories'))!).directories[0]).toMatchObject({
      path: 'й',
      localPath: replacement,
      identity: 'replacement',
      file_id: 'dir',
      version_id: 'v1',
    })
  }
)

it('keeps a case-only directory rename as a move of the existing identity', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  fs.dirs.set('Й', 'original')
  const sent: V2CommitOp[] = []
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async (ops) => {
      sent.push(...ops)
      return [{ status: 'applied', file_id: 'dir', version_id: 'v2', path: 'й', mtime: 1 } as never]
    }
  )
  await dirs.receive({ kind: 'directory', path: 'Й', file_id: 'dir', version_id: 'v1', mtime: 1 })
  fs.dirs.delete('Й')
  fs.dirs.set('й'.normalize('NFD'), 'original')
  await fs.writeAtomic('й'.normalize('NFD') + '/child', new Uint8Array([1]), 1)
  await state.put({
    path: 'Й/child',
    wirePath: 'Й/child',
    fileId: 'child',
    versionId: 'v1',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  })
  await dirs.scan()
  expect(sent).toEqual([
    { op: 'move_directory', file_id: 'dir', base_version_id: 'v1', to_path: 'й' },
  ])
})

it('does not replay a pending recursive deletion over an occupied canonical directory', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  const pending = {
    key: 'uncertain-delete',
    op: { op: 'delete_directory', file_id: 'dir', base_version_id: 'v1' },
    identity: 'old',
    localPath: 'й',
  }
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [
        {
          kind: 'directory',
          file_id: 'dir',
          version_id: 'v1',
          path: 'й',
          localPath: 'й',
          identity: 'old',
          mtime: 1,
        },
      ],
      pending,
      removals: [],
    })
  )
  fs.dirs.set('й'.normalize('NFD'), 'new')
  const sent: V2CommitOp[] = []
  await expect(
    new V2Directories(
      fs,
      state,
      () => true,
      async (ops) => {
        sent.push(...ops)
        return [
          { status: 'rejected', code: 'invalid_request', message: 'must not replay' } as never,
        ]
      }
    ).scan()
  ).resolves.toBeUndefined()
  expect(sent).toEqual([])
  expect(JSON.parse((await state.getMeta('v2-directories'))!).pending).toBeUndefined()
  expect(JSON.parse((await state.getMeta('v2-directory-review'))!)).toEqual([
    expect.objectContaining({ pending }),
  ])
})

it('retires stale cleanup of a case alias whose physical identity is still tracked', async () => {
  class GuardedFs extends DirectoryFs {
    async removeDirectory() {
      throw new Error('must not remove tracked identity')
    }
  }
  const fs = new GuardedFs(),
    state = new MemoryStateStore()
  fs.dirs.set('й', 'stable')
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [
        {
          kind: 'directory',
          file_id: 'dir',
          version_id: 'v2',
          path: 'й',
          localPath: 'й',
          identity: 'stable',
          mtime: 1,
        },
      ],
      removals: [{ path: 'Й', localPath: 'Й', identity: 'stable' }],
    })
  )
  await new V2Directories(
    fs,
    state,
    () => true,
    async () => []
  ).finishPull()
  expect([...fs.dirs.keys()]).toEqual(['й'])
  expect(JSON.parse((await state.getMeta('v2-directories'))!).removals).toEqual([])
})

it('publishes NFC directories and treats a normalization-only rename as a wire no-op', async () => {
  const fs = new DirectoryFs()
  const raw = 'Sample/й-folder/ё-empty'.normalize('NFD')
  fs.dirs.set(raw, 'stable')
  const ops: V2CommitOp[] = []
  const dirs = new V2Directories(
    fs,
    new MemoryStateStore(),
    () => true,
    async (batch) => {
      ops.push(...batch)
      const op = batch[0]!
      if (op.op !== 'mkdir') throw new Error('unexpected operation')
      validatePath(op.path)
      return [
        { status: 'applied', file_id: 'dir', version_id: 'v1', path: op.path, mtime: 1 } as never,
      ]
    }
  )
  await dirs.scan()
  expect(ops).toEqual([{ op: 'mkdir', path: raw.normalize('NFC'), mtime: 1 }])
  fs.dirs.delete(raw)
  fs.dirs.set(raw.normalize('NFC'), 'stable')
  await dirs.scan()
  expect(ops).toHaveLength(1)
})

it('receives an NFC directory using its existing decomposed physical identity', async () => {
  const fs = new DirectoryFs()
  const raw = 'й-folder/ё-empty'.normalize('NFD')
  fs.dirs.set(raw, 'stable')
  const state = new MemoryStateStore()
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async () => []
  )
  await dirs.receive({
    kind: 'directory',
    file_id: 'dir',
    version_id: 'v1',
    path: raw.normalize('NFC'),
    mtime: 1,
  })
  expect(JSON.parse((await state.getMeta('v2-directories'))!).directories[0]).toMatchObject({
    localPath: raw,
    identity: 'stable',
  })
  expect([...fs.dirs.keys()]).toEqual([raw])
})

it('replays an old raw pending request exactly before replacing a definitive rejection', async () => {
  const fs = new DirectoryFs()
  const raw = 'й-folder'.normalize('NFD')
  fs.dirs.set(raw, 'stable')
  const state = new MemoryStateStore()
  const original = { op: 'mkdir', path: raw, mtime: 1 }
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [],
      removals: [],
      pending: { key: 'old-key', op: original, identity: 'stable' },
    })
  )
  const requests: Array<{ key: string; op: V2CommitOp }> = []
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async (ops, key) => {
      requests.push({ key, op: ops[0]! })
      if (key === 'old-key')
        return [{ status: 'rejected', code: 'invalid_path', message: 'not nfc' } as never]
      return [
        {
          status: 'applied',
          file_id: 'dir',
          version_id: 'v1',
          path: raw.normalize('NFC'),
          mtime: 1,
        } as never,
      ]
    }
  )
  await dirs.scan()
  await dirs.scan()
  expect(requests[0]).toEqual({ key: 'old-key', op: original })
  expect(requests[1]!.key).not.toBe('old-key')
  expect(requests[1]!.op).toMatchObject({ path: raw.normalize('NFC') })
})

it('does not remove a replacement directory at a departed local path', async () => {
  class RemovableFs extends DirectoryFs {
    async removeDirectory(path: string) {
      this.dirs.delete(path)
    }
  }
  const fs = new RemovableFs()
  fs.dirs.set('Empty', 'original')
  const dirs = new V2Directories(
    fs,
    new MemoryStateStore(),
    () => true,
    async () => []
  )
  await dirs.receive({
    kind: 'directory',
    file_id: 'dir',
    version_id: 'v1',
    path: 'Empty',
    mtime: 1,
  })
  await dirs.departed('dir')
  fs.dirs.set('Empty', 'replacement')
  await dirs.finishPull()
  expect(fs.dirs.get('Empty')).toBe('replacement')
})

it('holds incoming collided directories durably and permits unrelated directory exchange', async () => {
  const fs = new DirectoryFs()
  fs.dirs.set('й', 'one')
  fs.dirs.set('й'.normalize('NFD'), 'two')
  const state = new MemoryStateStore()
  const dirs = new V2Directories(
    fs,
    state,
    (path) => path !== 'й',
    async (ops) => {
      const op = ops[0]!
      if (op.op !== 'mkdir') throw new Error('unexpected operation')
      return [
        { status: 'applied', file_id: 'safe', version_id: 'v1', path: op.path, mtime: 1 } as never,
      ]
    }
  )
  await dirs.receive({
    kind: 'directory',
    file_id: 'remote',
    version_id: 'v1',
    path: 'й/child',
    mtime: 1,
  })
  await dirs.receive({
    kind: 'directory',
    file_id: 'safe',
    version_id: 'v1',
    path: 'Safe',
    mtime: 1,
  })
  expect(fs.dirs.has('Safe')).toBe(true)
  expect([...fs.dirs.keys()]).not.toContain('й/child')
  fs.dirs.delete('й'.normalize('NFD'))
  await dirs.scan()
  expect(fs.dirs.has('й/child')).toBe(true)
})

it('keeps uncertain requests byte-for-byte with the same idempotency key across restart', async () => {
  const fs = new DirectoryFs()
  fs.dirs.set('й'.normalize('NFD'), 'stable')
  const state = new MemoryStateStore()
  const requests: unknown[] = []
  const lost = new V2Directories(
    fs,
    state,
    () => true,
    async (ops, key) => {
      requests.push({ ops, key })
      throw new Error('response lost')
    }
  )
  await expect(lost.scan()).rejects.toThrow('response lost')
  const restart = new V2Directories(
    fs,
    state,
    () => true,
    async (ops, key) => {
      requests.push({ ops, key })
      return [{ status: 'applied', file_id: 'dir', version_id: 'v1', path: 'й', mtime: 1 } as never]
    }
  )
  await restart.scan()
  await restart.scan()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
})

it('preserves unsupported or malformed metadata without resetting evidence', async () => {
  for (const raw of [
    '{"schemaVersion":3,"directories":[],"removals":[]}',
    '{"directories":false}',
  ]) {
    const state = new MemoryStateStore()
    await state.setMeta('v2-directories', raw)
    const dirs = new V2Directories(
      new DirectoryFs(),
      state,
      () => true,
      async () => {
        throw new Error('must not send')
      }
    )
    await expect(dirs.scan()).rejects.toThrow()
    expect(await state.getMeta('v2-directories')).toBe(raw)
  }
})

it('migrates a successful legacy record by stable identity without publishing a move', async () => {
  const state = new MemoryStateStore(),
    fs = new DirectoryFs()
  fs.dirs.set('й'.normalize('NFD'), 'stable')
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [
        {
          kind: 'directory',
          path: 'й',
          identity: 'stable',
          file_id: 'dir',
          version_id: 'v1',
          mtime: 1,
        },
      ],
      removals: [],
    })
  )
  await new V2Directories(
    fs,
    state,
    () => true,
    async () => {
      throw new Error('must not send')
    }
  ).scan()
  expect(JSON.parse((await state.getMeta('v2-directories'))!)).toMatchObject({
    schemaVersion: 2,
    directories: [{ localPath: 'й'.normalize('NFD'), file_id: 'dir' }],
  })
})

it('retains a tracked directory collision across restart after its winner vanishes', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  fs.dirs.set('й', 'winner')
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async () => {
      throw new Error('must not send')
    }
  )
  await dirs.receive({ kind: 'directory', path: 'й', file_id: 'dir', version_id: 'v1', mtime: 1 })
  const loser = 'й'.normalize('NFD')
  // Host enumeration need not be parents-first. Inferred ancestors must retain
  // the trusted identity when their explicit directory record arrives later.
  fs.dirs.delete('й')
  fs.dirs.set('й/child', 'child')
  fs.dirs.set('й', 'winner')
  fs.dirs.set(loser, 'loser')
  await refreshLocalPaths(fs, state)
  fs.dirs.delete('й/child')
  fs.dirs.delete('й')
  await refreshLocalPaths(fs, state)
  await new V2Directories(
    fs,
    state,
    () => true,
    async () => {
      throw new Error('must not send')
    }
  ).scan()
  await dirs.receive({
    kind: 'directory',
    path: 'й/new',
    file_id: 'new',
    version_id: 'v1',
    mtime: 1,
  })
  expect([...fs.dirs.keys()]).toEqual([loser])
  expect(JSON.parse((await state.getMeta('v2-directories'))!).directories[0].identity).toBe(
    'winner'
  )
})

it('retires a rejected old raw-NFD move before sending a normalized move with a new key', async () => {
  const fs = new DirectoryFs(),
    state = new MemoryStateStore()
  const raw = 'ё-moved'.normalize('NFD')
  fs.dirs.set(raw, 'stable')
  await fs.writeAtomic(raw + '/child', new Uint8Array([1]), 1)
  await state.put({
    path: 'Old/child',
    wirePath: 'Old/child',
    fileId: 'child',
    versionId: 'v1',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
  })
  const original = { op: 'move_directory', file_id: 'dir', base_version_id: 'v1', to_path: raw }
  await state.setMeta(
    'v2-directories',
    JSON.stringify({
      directories: [
        {
          kind: 'directory',
          path: 'Old',
          identity: 'stable',
          file_id: 'dir',
          version_id: 'v1',
          mtime: 1,
        },
      ],
      removals: [],
      pending: { key: 'old-move', op: original, identity: 'stable' },
    })
  )
  const requests: Array<{ key: string; op: V2CommitOp }> = []
  const dirs = new V2Directories(
    fs,
    state,
    () => true,
    async (ops, key) => {
      requests.push({ key, op: ops[0]! })
      if (key === 'old-move')
        return [{ status: 'rejected', code: 'invalid_path', message: 'not nfc' } as never]
      return [
        {
          status: 'applied',
          file_id: 'dir',
          version_id: 'v2',
          path: raw.normalize('NFC'),
          mtime: 1,
        } as never,
      ]
    }
  )
  await dirs.scan()
  await dirs.scan()
  expect(requests[0]).toEqual({ key: 'old-move', op: original })
  expect(requests[1]!.key).not.toBe('old-move')
  expect(requests[1]!.op).toEqual({ ...original, to_path: raw.normalize('NFC') })
})
