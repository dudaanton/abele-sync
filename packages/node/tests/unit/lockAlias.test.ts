import { mkdtemp, rm } from 'node:fs/promises'
import { symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { acquireLock, sameLockDirectory, type Lock } from '../../src/index.js'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    // A bind mount resolves to its own pathname while stat sees the same dev/ino.
    // Preserve our symlink's pathname to reproduce that property without a mount.
    realpathSync: (path: string) => resolve(path),
  }
})

it('compares both device and inode without losing integer precision', () => {
  const first = { dev: 1n, ino: 9_007_199_254_740_992n }
  expect(sameLockDirectory(first, { ...first })).toBe(true)
  expect(sameLockDirectory(first, { ...first, dev: 2n })).toBe(false)
  expect(sameLockDirectory(first, { ...first, ino: first.ino + 1n })).toBe(false)
})

it('refuses a live lock through an alias whose canonical pathname differs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-lock-alias-'))
  const alias = join(dir, 'alias')
  let first: Lock | undefined
  let second: Lock | undefined
  try {
    symlinkSync(dir, alias, 'dir')
    first = await acquireLock(dir)
    const before = readFileSync(join(dir, '.abele-sync/lock'), 'utf8')
    await expect(
      acquireLock(alias).then((lock) => {
        second = lock
        return lock
      })
    ).rejects.toThrow(/another abele-sync is running/)
    expect(first.held()).toBe(true)
    expect(readFileSync(join(dir, '.abele-sync/lock'), 'utf8')).toBe(before)
  } finally {
    second?.()
    first?.()
    await rm(dir, { recursive: true, force: true })
  }
})
