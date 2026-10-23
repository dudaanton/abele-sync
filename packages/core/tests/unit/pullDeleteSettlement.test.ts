import { expect, it, vi } from 'vitest'
import { ExpectedWrites, MemoryFileSystem, MemoryStateStore, sha256 } from '../../src/index.js'
import { PullPlacer } from '../../src/pullPlace.js'
import type { EngineClient } from '../../src/engineClient.js'

async function fixture() {
  const fs = new MemoryFileSystem({ caseInsensitive: true })
  const state = new MemoryStateStore()
  const bytes = new Uint8Array([1])
  const base = {
    path: 'Café.md',
    wirePath: 'Café.md',
    fileId: 'file',
    versionId: 'v1',
    sha: await sha256(bytes),
    size: 1,
    mtime: 1,
  }
  await fs.writeAtomic(base.path, bytes, 1)
  await state.put(base)
  await state.setCursor(1)
  const expected = new ExpectedWrites()
  const clear = vi.spyOn(expected, 'clear')
  const placer = new PullPlacer(
    {} as EngineClient,
    fs,
    state,
    {
      dirty: new Set(),
      expected,
      filter: { excluded: () => false },
    },
    sha256
  )
  return { fs, state, base, placer, clear }
}

it.each(['identity', 'version', 'case', 'unicode'])(
  'does not publish a completed incoming deletion over a replacement %s owner',
  async (mode) => {
    const { fs, state, base, placer, clear } = await fixture()
    const replacement = {
      ...base,
      fileId: mode === 'version' ? base.fileId : 'replacement',
      versionId: 'new',
      path: mode === 'case' ? 'CAFÉ.md' : mode === 'unicode' ? 'Café.md' : base.path,
    }
    const conditional = fs.conditionalFile.bind(fs)
    fs.conditionalFile = async (operation) => {
      const result = await conditional(operation)
      await state.put(replacement)
      return result
    }
    expect(await placer.drop(base)).toBe(false)
    expect(await state.get(replacement.path)).toEqual(replacement)
    expect(clear).not.toHaveBeenCalled()
  }
)

it('rolls deletion publication back with its applied frontier and does not acknowledge memory', async () => {
  const { fs, state, base, placer, clear } = await fixture()
  const transaction = state.transaction.bind(state)
  state.transaction = (work) =>
    transaction(async (tx) => {
      tx.setCursor = async () => {
        throw new Error('cursor publication failed')
      }
      return work(tx)
    })
  await expect(placer.drop(base)).rejects.toThrow('cursor publication failed')
  expect(await state.get(base.path)).toEqual(base)
  expect(await state.getCursor()).toBe(1)
  expect(await state.getMeta(`pull-base:${base.path}`)).not.toBeNull()
  expect(await fs.stat(base.path)).toBeNull()
  expect(clear).not.toHaveBeenCalled()
})

it('retains deletion recovery evidence when a file is recreated before publication', async () => {
  const { fs, state, base, placer, clear } = await fixture()
  const recreated = new Uint8Array([9])
  const conditional = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (operation) => {
    const result = await conditional(operation)
    await fs.writeAtomic(base.path, recreated, base.mtime)
    return result
  }
  expect(await placer.drop(base)).toBe(false)
  expect(await state.get(base.path)).toEqual(base)
  expect(await state.getMeta(`pull-base:${base.path}`)).not.toBeNull()
  expect(await fs.read(base.path)).toEqual(recreated)
  expect(clear).not.toHaveBeenCalled()
})
