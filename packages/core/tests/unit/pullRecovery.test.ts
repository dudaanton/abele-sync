import { describe, expect, it, vi } from 'vitest'
import {
  MemoryFileSystem,
  MemoryStateStore,
  recoverPendingPullWrites,
  sha256,
  decodePullIntent,
  type FileSystem,
} from '../../src/index.js'

async function fixture() {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore(),
    bytes = new TextEncoder().encode('recorded installation'),
    sha = await sha256(bytes)
  const base = {
    path: 'a.bin',
    wirePath: 'a.bin',
    fileId: 'file',
    versionId: 'old',
    sha: await sha256(new Uint8Array([0, 0, 0])),
    size: 3,
    mtime: 1,
  }
  await state.put(base)
  await fs.writeAtomic('a.bin', new Uint8Array([0, 0, 0]), 1)
  await fs.conditionalFile({
    path: 'a.bin',
    expected: base,
    effect: { kind: 'write', bytes, mtime: 2, receipt: 'installation' },
  })
  const intent = {
    receiptId: 'installation',
    fileId: 'file',
    versionId: 'new',
    wirePath: 'a.bin',
    sha,
    size: bytes.length,
    mtime: 2,
    target: 'a.bin',
    from: null,
    base,
  }
  await state.setMeta('pull-write:file', JSON.stringify(intent))
  return { fs, state, intent, base }
}
describe('normal-pull recovery before engine activation', () => {
  it.each([false, true])(
    'adopts an installed stage without replaying it when no streaming client is available (buffered=%s)',
    async (buffered) => {
      const f = await fixture()
      const fs: FileSystem = f.fs
      const { receiptId, ...intent } = f.intent
      await f.state.setMeta(
        'pull-write:file',
        JSON.stringify({ ...intent, stageId: 'installed-stage' })
      )
      let discarded = false
      const unexpected = vi.fn(async () => {
        throw new Error('installed stage must not be replayed')
      })
      const discard = vi.fn(async () => {
        discarded = true
        await f.fs.discardInstallation(receiptId)
      })
      fs.reopenStage = vi.fn(async (id) => {
        expect(id).toBe('installed-stage')
        if (discarded) throw Object.assign(new Error('stage is gone'), { code: 'ENOENT' })
        return {
          id,
          offset: f.intent.size,
          append: unexpected,
          seal: unexpected,
          commit: unexpected,
          discard,
          installed: () => f.fs.installedFile(receiptId, intent.target, intent.sha),
        }
      })
      const client = buffered ? { getBlob: unexpected } : undefined
      const bytes = await fs.read(intent.target)
      await recoverPendingPullWrites(fs, f.state, ['file'], client)
      expect(await f.state.byFileId('file')).toMatchObject({ versionId: 'new', sha: intent.sha })
      expect(await fs.read(intent.target)).toEqual(bytes)
      expect(discard).toHaveBeenCalledExactlyOnceWith()
      expect(unexpected).not.toHaveBeenCalled()
      expect(await f.state.getMeta('pull-write:file')).toBeNull()
      expect(await f.state.getMeta('pull-cleanup-head')).toBeNull()
      await recoverPendingPullWrites(fs, f.state, ['file'], client)
      expect(discard).toHaveBeenCalledTimes(1)
    }
  )
  it('keeps host stage ids opaque while rejecting empty or unbounded ids', async () => {
    const { intent } = await fixture()
    expect(
      decodePullIntent(JSON.stringify({ ...intent, stageId: 'plugin-stage-123' }), 'file').stageId
    ).toBe('plugin-stage-123')
    for (const stageId of ['', 'a'.repeat(129), 12])
      expect(() => decodePullIntent(JSON.stringify({ ...intent, stageId }), 'file')).toThrow()
  })
  it('settles only a recorded exact-version installation and its unchanged pre-write ledger base, without filesystem mutation', async () => {
    const f = await fixture(),
      write = vi.spyOn(f.fs, 'writeAtomic'),
      remove = vi.spyOn(f.fs, 'remove'),
      move = vi.spyOn(f.fs, 'move')
    await recoverPendingPullWrites(f.fs, f.state, ['file'])
    expect(await f.state.byFileId('file')).toMatchObject({ versionId: 'new', sha: f.intent.sha })
    expect(await f.state.getMeta('pull-write:file')).toBeNull()
    expect(write).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  })
  it('never adopts matching content without the recorded intent or across a changed ledger base', async () => {
    const f = await fixture()
    await f.state.setMeta('pull-write:file', null)
    await recoverPendingPullWrites(f.fs, f.state, ['file'])
    expect(await f.state.byFileId('file')).toEqual(f.base)
    await f.state.setMeta('pull-write:file', JSON.stringify(f.intent))
    await f.state.put({ ...f.base, versionId: 'different' })
    await expect(recoverPendingPullWrites(f.fs, f.state, ['file'])).rejects.toMatchObject({
      reason: 'recovery-required',
    })
    expect(await f.state.getMeta('pull-write:file')).not.toBeNull()
  })
  it('preserves changed bytes and their earlier base instead of overwriting or promoting them', async () => {
    const f = await fixture(),
      edited = new TextEncoder().encode('local edit')
    await f.fs.writeAtomic('a.bin', edited, 3)
    await recoverPendingPullWrites(f.fs, f.state, ['file'])
    expect(await f.fs.read('a.bin')).toEqual(edited)
    expect(await f.state.byFileId('file')).toEqual(f.base)
    expect(await f.state.getMeta('pull-write:file')).toBeNull()
  })
  it('holds corrupt intents rather than treating them as an empty ledger', async () => {
    const f = await fixture()
    await f.state.setMeta('pull-write:file', JSON.stringify({ ...f.intent, sha: null }))
    await expect(recoverPendingPullWrites(f.fs, f.state, ['file'])).rejects.toMatchObject({
      reason: 'recovery-required',
    })
    expect(await f.state.byFileId('file')).toEqual(f.base)
  })
})
