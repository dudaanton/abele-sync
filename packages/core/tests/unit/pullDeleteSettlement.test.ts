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

it('preserves an equal-byte replacement installed before conditional removal', async () => {
  const { fs, state, base, placer } = await fixture()
  const bytes = await fs.read(base.path)
  const replacement = { ...base, fileId: 'replacement', versionId: 'new' }
  const conditional = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (operation) => {
    await fs.writeAtomic(base.path, bytes, base.mtime)
    await state.put(replacement)
    return conditional(operation)
  }
  expect(await placer.drop(base)).toBe(false)
  expect(await state.get(base.path)).toEqual(replacement)
  expect(await fs.read(base.path)).toEqual(bytes)
})

it('rechecks ledger ownership inside conditional removal even without an object replacement', async () => {
  const { fs, state, base, placer } = await fixture()
  const replacement = { ...base, fileId: 'replacement', versionId: 'new' }
  const conditional = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (operation) => {
    await state.put(replacement)
    return conditional(operation)
  }
  expect(await placer.drop(base)).toBe(false)
  expect(await state.get(base.path)).toEqual(replacement)
  expect(await fs.read(base.path)).toEqual(new Uint8Array([1]))
})

it('carries object identity when equal bytes replace the file without a ledger change', async () => {
  const { fs, state, base, placer } = await fixture()
  const bytes = await fs.read(base.path)
  const conditional = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (operation) => {
    expect(operation.expected?.identity).toBe(await fs.fileIdentity(base.path))
    await fs.writeAtomic(base.path, bytes, base.mtime)
    return conditional(operation)
  }
  expect(await placer.drop(base)).toBe(false)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(bytes)
})

it.each([false, true])(
  'retains a racing replacement without object identity (ownership port=%s)',
  async (ownership) => {
    const { fs, state, base, placer } = await fixture()
    Object.defineProperty(fs, 'fileIdentity', { value: undefined })
    Object.defineProperty(fs, 'conditionalOwnership', { value: ownership ? true : undefined })
    const bytes = await fs.read(base.path)
    const replacement = { ...base, fileId: 'replacement', versionId: 'new' }
    const conditional = fs.conditionalFile.bind(fs)
    fs.conditionalFile = async (operation) => {
      await fs.writeAtomic(base.path, bytes, base.mtime)
      await state.put(replacement)
      // A legacy host does not interpret a new optional callback.
      return conditional({ ...operation, authorize: undefined })
    }
    expect(await placer.drop(base)).toBe(false)
    expect(await state.get(base.path)).toEqual(replacement)
    const retained = [...fs.snapshot()].filter(([path]) =>
      path.startsWith(`${base.path}.sync-conflict-`)
    )
    expect(retained).toHaveLength(1)
    expect(retained[0]![1]).toEqual(bytes)
  }
)

it('does not remove a file recreated after observing an absent object identity', async () => {
  const { fs, state, base, placer } = await fixture()
  const bytes = await fs.read(base.path)
  await fs.remove(base.path)
  const conditional = fs.conditionalFile.bind(fs)
  fs.conditionalFile = async (operation) => {
    await fs.writeAtomic(base.path, bytes, base.mtime)
    return conditional(operation)
  }
  expect(await placer.drop(base)).toBe(false)
  expect(await state.get(base.path)).toEqual(base)
  expect(await fs.read(base.path)).toEqual(bytes)
})

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
