import { expect, it, vi } from 'vitest'
import {
  MemoryStateStore,
  MemoryFileSystem,
  ScopedState,
  createScopedClient,
  encodeText,
  sha256,
  pushScoped,
} from '../../src/index.js'
for (const mode of ['move', 'restore', 'conflict'] as const)
  it(`retains another detached identity during scoped ${mode} settlement without stealing its placement`, async () => {
    const bound = await createScopedClient({
      baseUrl: 'https://issuer.example.test',
      token: 'absk_' + 'a'.repeat(43),
      fetch: vi.fn(),
      vaultId: 'vault',
      grantId: 'grant',
      principalId: 'key',
      principalKind: 'key',
    })
    const raw = new MemoryStateStore(),
      state = await ScopedState.open(raw, bound.binding, { initialize: true }),
      store = state.placementStore(),
      fs = new MemoryFileSystem(),
      a = encodeText('AAA'),
      b = encodeText('BBB'),
      newA = encodeText('new AAA'),
      shaA = await sha256(a),
      shaB = await sha256(b),
      shaNew = await sha256(newA)
    for (const [id, path, sha, bytes, status] of [
      ['a', 'Agents/a.md', shaA, a, mode === 'restore' ? 'deleted' : 'materialized'],
      ['b', 'Agents/b.md', shaB, b, 'detached'],
    ] as const) {
      await fs.writeAtomic(path, bytes, 1)
      await store.put({
        path,
        wirePath: path,
        fileId: id,
        versionId: id + '1',
        sha,
        size: bytes.length,
        mtime: 1,
      })
      await state.putKnown({
        file_id: id,
        version_id: id + '1',
        path,
        sha,
        size: bytes.length,
        mtime: 1,
        state: status,
        dirty: false,
      })
    }
    const retained = await store.byFileId('b')
    if (mode === 'conflict') await fs.writeAtomic('Agents/a.md', newA, 2)
    const result =
      mode === 'conflict'
        ? {
            status: 'conflict' as const,
            file_id: 'a',
            version_id: 'a2',
            path: 'Agents/a.md',
            sha: shaA,
            size: 3,
            mtime: 1,
            conflict_file_id: 'copy',
            conflict_version_id: 'c1',
            conflict_path: 'Agents/b.md',
          }
        : {
            status: 'applied' as const,
            file_id: 'a',
            version_id: 'a2',
            path: 'Agents/b.md',
            sha: shaA,
            size: 3,
            mtime: 1,
          }
    const client = {
      binding: bound.binding,
      negotiate: async () => ({ state: { state: 'active', role: 'editor' } }),
      putBlob: vi.fn(),
      commit: async () => ({ outcome_id: 'out', acknowledged: false, results: [result] }),
      version: async (id: string) => (id === 'copy' ? newA : a),
    }
    const op =
      mode === 'move'
        ? { op: 'move' as const, file_id: 'a', base_version_id: 'a1', to_path: 'Agents/b.md' }
        : mode === 'restore'
          ? { op: 'restore' as const, file_id: 'a', version_id: 'a1' }
          : {
              op: 'modify' as const,
              file_id: 'a',
              base_version_id: 'a1',
              sha: shaNew,
              size: 7,
              mtime: 2,
            }
    const report = await pushScoped({ client, state, fs, ops: [op] })
    expect(await fs.read('Agents/b.md')).toEqual(b)
    expect(await store.byFileId('b')).toEqual(retained)
    expect(report.held).toContain(mode === 'conflict' ? 'copy' : 'a')
    expect((await state.getKnown('b'))?.state).toBe('detached')
  })
