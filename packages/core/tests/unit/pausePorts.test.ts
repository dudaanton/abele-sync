import { expect, it, vi } from 'vitest'
import type { FileSystem } from '../../src/fs.js'
import { stoppableFileEffects } from '../../src/guard.js'
import { SyncCancelled } from '../../src/cancellation.js'

// This exhaustive port inventory makes a new FileSystem method a type error until
// its pause behavior is explicitly classified. Cleanup never publishes public bytes.
const ports = {
  pathKey: 'read',
  conditionalFile: 'effect',
  installedFile: 'read',
  discardInstallation: 'cleanup',
  recoverConditionalFiles: 'effect',
  list: 'read',
  listDirectories: 'read',
  listChildren: 'read',
  mkdir: 'effect',
  moveDirectory: 'effect',
  removeDirectory: 'effect',
  read: 'read',
  writeAtomic: 'effect',
  move: 'effect',
  remove: 'effect',
  stat: 'read',
  watch: 'read',
  openRead: 'read',
  fingerprint: 'read',
  fileIdentity: 'read',
  beginAtomicWrite: 'effect',
  reopenStage: 'effect',
  discardStage: 'cleanup',
} satisfies Record<keyof FileSystem, 'effect' | 'read' | 'cleanup'>

it.each(Object.entries(ports).filter(([, kind]) => kind === 'effect'))(
  'D-148 fences %s after pause',
  async (name) => {
    const called = vi.fn(async () => {})
    const fs = { [name]: called } as unknown as FileSystem
    const controller = new AbortController()
    const guarded = stoppableFileEffects(fs, () => controller.signal)
    controller.abort()
    await expect(
      (guarded[name as keyof FileSystem] as () => Promise<unknown>)()
    ).rejects.toBeInstanceOf(SyncCancelled)
    expect(called).not.toHaveBeenCalled()
  }
)
