import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { acquireLock, removeIf, type Lock } from '../../src/lock.js'

const hooks = vi.hoisted(() => ({
  created: null as (() => void) | null,
  removed: null as (() => void) | null,
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args)
      if (String(args[0]).endsWith('/lock') && args[1] === 'wx') hooks.created?.()
      return fd
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      fs.renameSync(...args)
      if (String(args[1]).endsWith('.removing')) hooks.removed?.()
    },
  }
})

it('does not grant a second lock while the first identity is being written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-start-lock-'))
  let first: Lock | undefined
  let stolen = false
  const file = join(dir, '.abele-sync', 'lock')
  try {
    hooks.created = () => {
      hooks.created = null
      // The competing starter judged the empty identity stale. Run its removal
      // synchronously at precisely that phase, as a separate process could.
      removeIf(file, (text) => text === '')
      if (!existsSync(file)) {
        stolen = true
        writeFileSync(file, 'second holder')
      }
    }
    first = await acquireLock(dir)
    expect(stolen).toBe(false)
    expect(first.held()).toBe(true)
  } finally {
    hooks.created = null
    first?.()
    await rm(dir, { recursive: true, force: true })
  }
})

it('never unlinks a replacement while checking whether it owns the lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-remove-lock-'))
  const file = join(dir, 'lock')
  try {
    writeFileSync(file, 'replacement')
    let exposed = false
    hooks.removed = () => {
      exposed = true
    }
    removeIf(file, (text) => text === 'old owner')
    expect(exposed).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('replacement')
  } finally {
    hooks.removed = null
    await rm(dir, { recursive: true, force: true })
  }
})
