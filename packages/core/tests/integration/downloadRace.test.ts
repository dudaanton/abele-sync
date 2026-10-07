import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  encodeText,
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  push,
  scan,
  sha256,
} from '../../src/index.js'
import { PullPlacer } from '../../src/pullPlace.js'
import type { ChangeItem } from '@abele/sync-protocol'
import type { VaultClient } from '../../src/client.js'
import { serverHarness, type Harness } from '../helpers/harness.js'

it('holds a pull when a fallback download races a same-stat local edit', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = encodeText('before'),
    incoming = encodeText('remote')
  const sha = await sha256(incoming)
  const entry = {
    path: 'a.md',
    wirePath: 'a.md',
    fileId: 'f',
    versionId: 'v',
    sha: await sha256(original),
    size: original.length,
    mtime: 1,
  }
  await fs.writeAtomic('a.md', original, 1)
  await state.put(entry)
  const client = {
    getBlob: async () => {
      await fs.writeAtomic('a.md', encodeText('typing'), 1)
      return incoming
    },
  } as unknown as VaultClient
  const placer = new PullPlacer(
    client,
    fs,
    state,
    { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
    sha256
  )
  const change = { file_id: 'f', version_id: 'v2', path: 'a.md', mtime: 3 } as ChangeItem
  expect(await placer.place(change, sha, entry, new Map(), new Map())).toBe(false)
  expect(new TextDecoder().decode(await fs.read('a.md'))).toBe('typing')
})

it('holds a pull when a fallback download races a local edit', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = encodeText('original'),
    incoming = encodeText('incoming')
  const sha = await sha256(incoming)
  const entry = {
    path: 'a.md',
    wirePath: 'a.md',
    fileId: 'f',
    versionId: 'v',
    sha: await sha256(original),
    size: original.length,
    mtime: 1,
  }
  await fs.writeAtomic('a.md', original, 1)
  await state.put(entry)
  const client = {
    getBlob: async () => {
      await fs.writeAtomic('a.md', encodeText('late edit'), 2)
      return incoming
    },
  } as unknown as VaultClient
  const placer = new PullPlacer(
    client,
    fs,
    state,
    { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
    sha256
  )
  const change = { file_id: 'f', version_id: 'v2', path: 'a.md', mtime: 3 } as ChangeItem
  expect(await placer.place(change, sha, entry, new Map(), new Map())).toBe(false)
  expect(new TextDecoder().decode(await fs.read('a.md'))).toBe('late edit')
  expect(await state.get('a.md')).toEqual(entry)
})

for (const existing of [false, true]) {
  it(`holds a pull when a local edit arrives after clearance of a ${existing ? 'synced' : 'new'} target`, async () => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const original = encodeText('old'),
      incoming = encodeText('remote')
    const sha = await sha256(incoming)
    const entry = existing
      ? {
          path: 'a.md',
          wirePath: 'a.md',
          fileId: 'f',
          versionId: 'v',
          sha: await sha256(original),
          size: original.length,
          mtime: 1,
        }
      : null
    if (entry !== null) {
      await fs.writeAtomic('a.md', original, 1)
      await state.put(entry)
    }
    const stat = fs.stat.bind(fs)
    let calls = 0
    fs.stat = async (path) => {
      if (path === 'a.md' && ++calls === 2) await fs.writeAtomic(path, encodeText('mine'), 5)
      return stat(path)
    }
    const client = { getBlob: async () => incoming } as unknown as VaultClient
    const placer = new PullPlacer(
      client,
      fs,
      state,
      { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
      sha256
    )
    const change = { file_id: 'f', version_id: 'v2', path: 'a.md', mtime: 3 } as ChangeItem
    expect(await placer.place(change, sha, entry, new Map(), new Map())).toBe(false)
    expect(new TextDecoder().decode(await fs.read('a.md'))).toBe('mine')
  })
}

it('holds a replacement file created while the old occupant ledger entry is deleted', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const original = encodeText('old occupant'),
    incoming = encodeText('remote replacement')
  await fs.writeAtomic('a.md', original, 1)
  await state.put({
    path: 'a.md',
    wirePath: 'a.md',
    fileId: 'old-id',
    versionId: 'v',
    sha: await sha256(original),
    size: original.length,
    mtime: 1,
  })
  const drop = state.delete.bind(state)
  state.delete = async (path) => {
    await drop(path)
    await fs.writeAtomic(path, encodeText('new local work'), 2)
  }
  const sha = await sha256(incoming)
  const placer = new PullPlacer(
    { getBlob: async () => incoming } as unknown as VaultClient,
    fs,
    state,
    { expected: new ExpectedWrites(), dirty: new Set(), filter: { excluded: () => false } },
    sha256
  )
  const change = { file_id: 'new-id', version_id: 'v2', path: 'a.md', mtime: 3 } as ChangeItem
  expect(await placer.place(change, sha, null, new Map(), new Map())).toBe(false)
  expect(new TextDecoder().decode(await fs.read('a.md'))).toBe('new local work')
  expect(await state.get('a.md')).toBeNull()
})

let h: Harness
beforeAll(async () => {
  h = await serverHarness()
})
afterAll(async () => {
  await h.close()
})

it('keeps typing made during download of a merge, including later prefetch runs', async () => {
  const { accountToken } = await h.account()
  const { vaultId } = await h.vault(accountToken)
  const { deviceToken } = await h.device(accountToken, vaultId)
  const client = h.clientFor(deviceToken, vaultId)
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const filter = { excluded: () => false }
  const opts = { expected: new ExpectedWrites(), prefetchBytes: 1 }
  const sync = async () => push(client, fs, state, await scan(fs, state, filter), opts)
  for (const path of ['a.md', 'b.md'])
    await fs.writeAtomic(path, encodeText('one\ntwo\nthree\n'), 1)
  await sync()
  for (const path of ['a.md', 'b.md']) {
    const base = (await state.get(path))!
    const bytes = encodeText('ONE\ntwo\nthree\n'),
      sha = await sha256(bytes)
    await client.putBlob(sha, bytes)
    await client.commit(
      [
        {
          op: 'modify',
          file_id: base.fileId,
          base_version_id: base.versionId,
          sha,
          size: bytes.length,
          mtime: 2,
        },
      ],
      path
    )
    await fs.writeAtomic(path, encodeText('one\ntwo\nTHREE\n'), 3)
  }
  const get = client.getBlob.bind(client)
  client.getBlob = async (sha) => {
    for (const path of ['a.md', 'b.md'])
      await fs.writeAtomic(path, encodeText('one\ntwo\nTHREE\nlate typing\n'), 4)
    return get(sha)
  }
  const report = await sync()
  expect(report.kept).toEqual(['a.md', 'b.md'])
  for (const path of ['a.md', 'b.md'])
    expect(new TextDecoder().decode(await fs.read(path))).toContain('late typing')
  expect((await scan(fs, state, filter)).ops.map((op) => op.op)).toEqual(['modify', 'modify'])
})
