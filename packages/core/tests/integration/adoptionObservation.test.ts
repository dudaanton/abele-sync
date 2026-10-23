import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  pull,
  push,
  scan,
  sha256,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'

let h: Harness
beforeAll(async () => {
  h = await serverHarness()
})
afterAll(async () => {
  await h.close()
})

it('uploads a recreated move source as a new server identity after holding adoption', async () => {
  const { accountToken } = await h.account()
  const { vaultId } = await h.vault(accountToken, 'Source recreation')
  const { deviceToken } = await h.device(accountToken, vaultId)
  const client = h.clientFor(deviceToken, vaultId)
  const a = new TextEncoder().encode('sample A'),
    b = new TextEncoder().encode('sample B')
  const shaA = await sha256(a),
    shaB = await sha256(b)
  await client.putBlob(shaA, a)
  const created = await client.commit(
    [{ op: 'create', path: 'old.md', sha: shaA, size: 8, mtime: 1000 }],
    'create'
  )
  const original = created.results[0]!
  if (original.status !== 'applied') throw new Error('create failed')
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const options = () => ({
    dirty: new Set<string>(),
    expected: new ExpectedWrites(),
    filter: { excluded: () => false },
  })
  await pull(client, fs, state, options())
  const base = await state.get('old.md')
  await fs.move('old.md', 'new.md')
  const moved = await client.commit(
    [
      {
        op: 'move',
        file_id: original.file_id,
        base_version_id: original.version_id,
        to_path: 'new.md',
      },
    ],
    'move'
  )
  expect(moved.results[0]?.status).toBe('applied')
  const stat = fs.stat.bind(fs)
  let injected = false
  fs.stat = async (path) => {
    const value = await stat(path)
    if (path === 'old.md' && value === null && !injected) {
      await fs.writeAtomic(path, b, 1000)
      injected = true
    }
    return value
  }
  const pulled = await pull(client, fs, state, options())
  expect(injected).toBe(true)
  expect(pulled.held.map((c) => c.file_id)).toContain(original.file_id)
  expect(await state.byFileId(original.file_id)).toEqual(base)
  const found = await scan(fs, state, options().filter)
  expect(found.ops.map((op) => op.op)).toEqual(['move', 'create'])
  const pushed = await push(client, fs, state, found, { expected: new ExpectedWrites() })
  expect(pushed.rejected).toEqual([])
  expect(pushed.kept).toEqual([])
  await pull(client, fs, state, options())
  expect(await fs.read('old.md')).toEqual(b)
  expect(await fs.read('new.md')).toEqual(a)
  expect(await state.get('old.md')).toMatchObject({ sha: shaB })
  expect((await state.get('old.md'))?.fileId).not.toBe(original.file_id)
  expect(await state.byFileId(original.file_id)).toMatchObject({ path: 'new.md', sha: shaA })
  const manifest = await client.manifest(null)
  expect(manifest.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ file_id: original.file_id, path: 'new.md', sha: shaA }),
      expect.objectContaining({ path: 'old.md', sha: shaB }),
    ])
  )
  expect((await scan(fs, state, options().filter)).ops).toEqual([])
})
