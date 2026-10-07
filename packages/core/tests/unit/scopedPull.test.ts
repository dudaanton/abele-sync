import { describe, expect, it, vi } from 'vitest'
import { pullScoped } from '../../src/scopedPull.js'
import { createScopedClient, ScopedState } from '../../src/scopedConnection.js'
import { MemoryStateStore } from '../../src/state.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { sha256, encodeText } from '../../src/hash.js'
const checkpoint = { kind: 'scoped' as const, token: 'complete' },
  item = async (version = 'v1', text = 'remote') => ({
    file_id: 'file',
    version_id: version,
    path: 'Agents/note.md',
    kind: 'note' as const,
    sha: await sha256(encodeText(text)),
    size: text.length,
    mtime: 1,
  })
async function fixture() {
  const bound = await createScopedClient({
    baseUrl: 'https://issuer.example.test',
    token: `absk_${'a'.repeat(43)}`,
    fetch: vi.fn() as unknown as typeof fetch,
    vaultId: 'vault',
    grantId: 'grant',
    principalId: 'key',
    principalKind: 'key',
  })
  const raw = new MemoryStateStore(),
    state = await ScopedState.open(raw, bound.binding, { initialize: true }),
    fs = new MemoryFileSystem(),
    file = await item()
  const client = {
    binding: bound.binding,
    negotiate: vi.fn(async () => ({
      state: { state: 'active' as const, role: 'editor' as const },
    })),
    openSnapshot: vi.fn(async () => ({
      snapshot_id: 'snapshot',
      items: [file],
      cursor: 'first',
      next_cursor: null,
      checkpoint,
      feed_checkpoint: checkpoint,
    })),
    snapshotPage: vi.fn(),
    feed: vi.fn(async () => ({ events: [], checkpoint, has_more: false })),
    head: vi.fn(async () => file),
    version: vi.fn(async () => encodeText('remote')),
  }
  return { raw, state, fs, file, client }
}
describe('scoped complete-view pull', () => {
  it('uses canonical Unicode keys for configured namespaces, including decomposed configuration spelling', async () => {
    for (const [config, path] of [
      ['ПРОЕКТ', 'проект/n.md'],
      ['ÉQUIPE'.normalize('NFD'), 'équipe/n.md'],
      ['İRİS', 'i̇ri̇s/n.md'],
    ]) {
      const f = await fixture()
      f.file.path = path!
      await expect(pullScoped({ ...f, configurationDirectories: [config!] })).rejects.toMatchObject(
        { code: 'protocol' }
      )
      expect(await f.fs.stat(path!)).toBeNull()
      expect(await f.state.getCheckpoint()).toBeNull()
    }
  })
  it('discards an incomplete inventory before writing files, advancing progress or detaching known data', async () => {
    const f = await fixture()
    f.client.openSnapshot.mockResolvedValueOnce({
      snapshot_id: 'snapshot',
      items: [f.file],
      cursor: 'first',
      next_cursor: 'next',
      checkpoint,
      feed_checkpoint: undefined,
    } as never)
    f.client.snapshotPage.mockRejectedValueOnce(new Error('offline page'))
    await expect(pullScoped(f)).rejects.toThrow('offline page')
    expect(await f.fs.stat(f.file.path)).toBeNull()
    expect(await f.state.getCheckpoint()).toBeNull()
  })
  it('materializes exact captured versions and keeps a dirty departure as detached work, never a local delete', async () => {
    const f = await fixture()
    await pullScoped(f)
    expect(await f.fs.read(f.file.path)).toEqual(encodeText('remote'))
    expect(await f.state.getCheckpoint()).toEqual(checkpoint)
    await f.fs.writeAtomic(f.file.path, encodeText('local'), 3)
    f.client.feed.mockResolvedValueOnce({
      events: [{ type: 'departed', file_id: 'file' }],
      checkpoint: { kind: 'scoped', token: 'after-departure' },
      has_more: false,
    } as never)
    const report = await pullScoped(f)
    expect(report.detached).toEqual(['file'])
    expect((await f.state.getKnown('file'))?.state).toBe('detached')
    expect(await f.fs.read(f.file.path)).toEqual(encodeText('local'))
  })
  it('holds a moved destination occupied by retained departed identity bytes', async () => {
    const f = await fixture(),
      a = { ...(await item('a1', 'AAA')), file_id: 'a', path: 'Agents/a.md' },
      b = { ...(await item('b1', 'BBB')), file_id: 'b', path: 'Agents/b.md' }
    f.client.openSnapshot.mockResolvedValueOnce({
      snapshot_id: 'snapshot',
      items: [a, b],
      cursor: 'first',
      next_cursor: null,
      checkpoint,
      feed_checkpoint: checkpoint,
    })
    f.client.version
      .mockImplementation(async () => encodeText('AAA'))
      .mockImplementationOnce(async () => encodeText('AAA'))
      .mockImplementationOnce(async () => encodeText('BBB'))
    await pullScoped(f)
    const moved = { ...a, version_id: 'a2', path: b.path }
    f.client.feed.mockResolvedValueOnce({
      events: [
        { type: 'departed', file_id: 'b' },
        { type: 'content', file: moved },
      ],
      checkpoint: { kind: 'scoped', token: 'next' },
      has_more: false,
    } as never)
    f.client.head.mockResolvedValue(moved)
    const report = await pullScoped(f)
    expect(report.held).toContain('a')
    expect(await f.fs.read(b.path)).toEqual(encodeText('BBB'))
    expect(await f.fs.read(a.path)).toEqual(encodeText('AAA'))
    expect((await f.state.getKnown('b'))?.state).toBe('detached')
  })
  for (const mode of ['create', 'modify', 'move'] as const)
    it(`adopts its exact completed ${mode} intent before collision/dirty/missing-source holds`, async () => {
      const f = await fixture()
      if (mode !== 'create') await pullScoped(f)
      const next = {
        ...(await item('v2', 'changed')),
        path: mode === 'move' ? 'Agents/moved.md' : f.file.path,
      }
      f.client.version.mockResolvedValue(encodeText('changed'))
      await f.state.setCheckpoint(null)
      f.client.openSnapshot.mockResolvedValue({
        snapshot_id: 'snapshot',
        items: [next],
        cursor: 'first',
        next_cursor: null,
        checkpoint,
        feed_checkpoint: checkpoint,
      })
      vi.spyOn(f.raw, 'put').mockRejectedValueOnce(new Error('crash before ledger'))
      await expect(pullScoped(f)).rejects.toThrow('crash before ledger')
      expect(await f.fs.read(next.path)).toEqual(encodeText('changed'))
      const recovered = await pullScoped(f)
      expect(recovered.held).toEqual([])
      expect(recovered.complete).toBe(true)
      expect((await f.state.getEntry(next.path))?.versionId).toBe('v2')
    })
  it('uses current authorized heads for old feed replay rather than replacing a newer settled version', async () => {
    const f = await fixture()
    const newest = await item('v3', 'newest')
    f.client.openSnapshot.mockResolvedValueOnce({
      snapshot_id: 'snapshot',
      items: [newest],
      cursor: 'first',
      next_cursor: null,
      checkpoint,
      feed_checkpoint: checkpoint,
    })
    f.client.version.mockResolvedValue(encodeText('newest'))
    await pullScoped(f)
    f.client.head.mockResolvedValue(newest)
    f.client.feed.mockResolvedValueOnce({
      events: [{ type: 'content', file: f.file }],
      checkpoint: { kind: 'scoped', token: 'next' },
      has_more: false,
    } as never)
    await pullScoped(f)
    expect(await f.fs.read(f.file.path)).toEqual(encodeText('newest'))
    expect((await f.state.getKnown('file'))?.version_id).toBe('v3')
  })
  it('retains a save during version retrieval and never advances beyond its held write', async () => {
    const f = await fixture()
    await pullScoped(f)
    const next = await item('v2', 'changed')
    f.client.head.mockResolvedValue(next)
    f.client.feed.mockResolvedValueOnce({
      events: [{ type: 'content', file: next }],
      checkpoint: { kind: 'scoped', token: 'next' },
      has_more: false,
    } as never)
    f.client.version.mockImplementationOnce(async () => {
      await f.fs.writeAtomic(f.file.path, encodeText('local save'), 8)
      return encodeText('changed')
    })
    expect((await pullScoped(f)).held).toEqual(['file'])
    expect(await f.fs.read(f.file.path)).toEqual(encodeText('local save'))
    expect(await f.state.getCheckpoint()).toEqual(checkpoint)
  })
  it('preserves untracked collisions, held local saves and known-not-materialized stubs', async () => {
    const f = await fixture()
    await f.fs.writeAtomic(f.file.path, encodeText('local'), 2)
    expect((await pullScoped(f)).held).toEqual(['file'])
    expect(await f.fs.read(f.file.path)).toEqual(encodeText('local'))
    const g = await fixture()
    const { kind: _kind, ...metadata } = g.file
    await g.state.putKnown({ ...metadata, state: 'known_not_materialized', dirty: false })
    await g.fs.writeAtomic(g.file.path, encodeText('stub'), 1)
    await pullScoped(g)
    expect(await g.fs.read(g.file.path)).toEqual(encodeText('stub'))
    expect(g.client.version).not.toHaveBeenCalled()
  })
})
