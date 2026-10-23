import { expect } from 'vitest'
import type { Journal, StateEntry, StateStore } from '../../src/state.js'

/** Replacing a path must never make another ID resolve to the replacement row. */
export async function identityReplacement(store: StateStore): Promise<void> {
  const original: StateEntry = {
    path: 'old.md',
    wirePath: 'old.md',
    fileId: 'original',
    versionId: 'base',
    sha: 'a'.repeat(64),
    size: 8,
    mtime: 1000,
  }
  for (const mode of ['direct', 'transaction', 'nested']) {
    await store.put(original)
    const replace = async (state: StateStore) => {
      await state.put({ ...original, fileId: 'recreated' })
      expect(await state.byFileId('original')).toBeNull()
      expect(await state.byFileId('recreated')).toMatchObject({ fileId: 'recreated' })
      await state.put({ ...original, path: 'new.md', wirePath: 'new.md' })
      await state.delete('old.md')
      expect(await state.byFileId('recreated')).toBeNull()
      expect(await state.byFileId('original')).toMatchObject({ path: 'new.md', fileId: 'original' })
    }
    if (mode === 'direct') await replace(store)
    else
      await store.transaction(async (tx) => {
        if (mode === 'nested') await tx.transaction(replace)
        else await replace(tx)
        expect(await tx.byFileId('original')).toMatchObject({ path: 'new.md', fileId: 'original' })
        expect(await tx.byFileId('recreated')).toBeNull()
      })
    expect(await store.byFileId('original')).toMatchObject({ path: 'new.md', fileId: 'original' })
    expect(await store.byFileId('recreated')).toBeNull()
    await store.delete('new.md')
  }
}

/** Shared with host adapters: an unrelated task must never join a suspended transaction. */
export async function rollbackIsolation(store: StateStore): Promise<void> {
  const entry: StateEntry = {
    path: 'shared.md',
    wirePath: 'shared.md',
    fileId: 'shared',
    versionId: 'outside',
    sha: 'a'.repeat(64),
    size: 1,
    mtime: 1,
  }
  const journal: Journal = {
    batchId: 'outside',
    idempotencyKey: 'outside',
    startedAt: '2026-01-01T00:00:00Z',
    ops: [],
  }
  await store.setMeta!('shared', 'before')
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const operation = store.transaction(async (tx) => {
    expect(tx).not.toBe(store)
    await tx.setMeta!('tentative', 'private')
    await tx.setMeta!('shared', 'transaction')
    await tx.put({ ...entry, versionId: 'tentative' })
    await tx.setCursor(1)
    await tx.setJournal({ ...journal, batchId: 'tentative' })
    entered()
    await gate
    expect(await tx.getMeta!('tentative')).toBe('private')
    expect((await tx.byFileId('shared'))?.versionId).toBe('tentative')
    throw new Error('rollback')
  })
  const rejected = expect(operation).rejects.toThrow('rollback')
  await ready
  expect(await store.getMeta!('tentative')).toBeNull()
  await store.setMeta!('unrelated', 'survives')
  await store.setMeta!('shared', 'unrelated wins')
  await store.put(entry)
  await store.setCursor(42)
  await store.setJournal(journal)
  release()
  await rejected
  expect(await store.getMeta!('unrelated')).toBe('survives')
  expect(await store.getMeta!('shared')).toBe('unrelated wins')
  expect(await store.getMeta!('tentative')).toBeNull()
  expect(await store.get('shared.md')).toEqual(entry)
  expect(await store.byFileId('shared')).toEqual(entry)
  expect(await store.getCursor()).toBe(42)
  expect(await store.getJournal()).toEqual(journal)
}
