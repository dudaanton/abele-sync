import { expect, it, vi } from 'vitest'
import { EngineError } from '@abele/sync-core'
import { runRestore } from '../../src/commands/restore.js'
import type { CommandContext } from '../../src/context.js'

const held = vi.hoisted(() => ({ value: true }))
const recover = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../src/codeGroupDisk.js', () => ({ CodeGroupDisk: { recover } }))
vi.mock('../../src/lock.js', () => ({
  acquireLock: async () => Object.assign(() => {}, { held: () => held.value }),
}))
vi.mock('../../src/log.js', () => ({ openLog: () => ({ line: () => {} }) }))
vi.mock('../../src/vault.js', () => ({
  vaultDir: (dir: string) => dir,
  requireConfig: () => {},
  recoverVault: recover,
  wirePath: (path: string) => path,
  fileIdFor: async () => 'f',
  DEFAULT_INTERVAL_SECONDS: 300,
  summarise: () => '',
  openVault: () => ({
    close: () => {},
    client: {
      trash: async () => [{ file_id: 'f', path: 'a.md', deleted_at: new Date().toISOString() }],
      restore: async () => {
        held.value = false
        return { status: 'applied', path: 'a.md' }
      },
      restoreDeletedMany: async () => {
        held.value = false
        return [{ status: 'applied', path: 'a.md' }]
      },
    },
  }),
  buildEngine: (_vault: unknown, opts: { stillHeld?: () => boolean }) => ({
    sync: async () => {
      if (opts.stillHeld?.() === false) throw new EngineError('lost', 'lock lost')
      return {}
    },
    stop: async () => {},
  }),
}))
it.each(['version', 'since'])(
  'a %s restore passes its lost-lock guard to the engine',
  async (kind) => {
    held.value = true
    recover.mockClear()
    const ctx = { io: { out: () => {} } } as unknown as CommandContext
    await expect(
      kind === 'version'
        ? runRestore('a.md', { dir: '.', version: 'v' }, ctx)
        : runRestore(undefined, { dir: '.', deletedSince: '2h', yes: true }, ctx)
    ).rejects.toMatchObject({ code: 'lost' })
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(expect.anything(), expect.any(Function))
  }
)
