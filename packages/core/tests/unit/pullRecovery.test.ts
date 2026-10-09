import { describe, expect, it, vi } from 'vitest'
import {
  MemoryFileSystem,
  MemoryStateStore,
  recoverPendingPullWrites,
  sha256,
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
    sha: 'a'.repeat(64),
    size: 3,
    mtime: 1,
  }
  await state.put(base)
  await fs.writeAtomic('a.bin', bytes, 2)
  const intent = {
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
