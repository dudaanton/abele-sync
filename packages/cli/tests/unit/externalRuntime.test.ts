import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig, stateFolder, readConfig } from '../../src/config.js'
import { acquireLock } from '../../src/lock.js'
import { openVault, recoverVault, buildEngine } from '../../src/vault.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import type { CommandContext } from '../../src/context.js'

let dir: string
const cfg = {
  serverUrl: 'https://synthetic.example.test',
  vaultId: 'vault',
  deviceId: 'device',
  deviceToken: 'absd_synthetic',
  deviceName: 'test',
  selective: selectiveDefaults(),
}
const ctx = (
  fetch: typeof globalThis.fetch = vi.fn(async () => new Response('{}'))
): CommandContext => ({ fetch, env: {}, revokeTimeoutMs: 20, io: { out: vi.fn(), err: vi.fn() } })
beforeEach(async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  dir = await mkdtemp(join(scratch, 'task3-runtime-'))
  writeConfig(dir, cfg)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})
describe('owned CLI effects after long awaits', () => {
  it('BUG: retained Restore/HTTP clients cannot bypass readiness or outlive their runtime', async () => {
    const lock = await acquireLock(dir),
      context = ctx(),
      vault = openVault(dir, context, lock.held)
    try {
      await expect(vault.client.restore('file', 'version')).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      expect(context.fetch).not.toHaveBeenCalled()
      await recoverVault(vault, lock.held)
      vault.close()
      await expect(vault.client.state()).rejects.toMatchObject({ code: 'lost' })
      expect(context.fetch).not.toHaveBeenCalled()
    } finally {
      vault.close()
      lock()
    }
  })
  it('BUG: multipart publication rechecks binding at each request, not just putBlob entry', async () => {
    const lock = await acquireLock(dir)
    const fetch = vi.fn(async () => {
      await Promise.resolve()
      writeConfig(dir, { ...cfg, deviceToken: 'absd_replacement' })
      return new Response(
        JSON.stringify({ upload_id: 'upload', part_size: 8 * 1024 * 1024, parts: 2, received: [] })
      )
    })
    const vault = openVault(dir, ctx(fetch), lock.held)
    try {
      await recoverVault(vault, lock.held)
      await expect(
        vault.client.putBlob('a'.repeat(64), new Uint8Array(8 * 1024 * 1024 + 1))
      ).rejects.toMatchObject({ code: 'lost' })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(readConfig(dir)!.deviceToken).toBe('absd_replacement')
    } finally {
      vault.close()
      lock()
    }
  })
  for (const operation of ['write', 'move', 'remove'] as const)
    it(`BUG: ${operation} rechecks the claim immediately before its native file mutation`, async () => {
      writeFileSync(join(dir, 'original.bin'), 'original')
      const lock = await acquireLock(dir),
        vault = openVault(dir, ctx(), lock.held)
      try {
        await recoverVault(vault, lock.held)
        const disk = vault.disk as unknown as {
          onlyFileOrNothing(a: string, b: string): Promise<void>
          recheck(a: string, b: string): Promise<void>
          contained(path: string): Promise<string>
        }
        const lose = () =>
          writeFileSync(
            join(stateFolder(dir), 'lock'),
            '123456\n' + JSON.stringify({ instance: 'successor' }) + '\n'
          )
        if (operation === 'write') {
          const real = disk.onlyFileOrNothing.bind(disk)
          let calls = 0
          vi.spyOn(disk, 'onlyFileOrNothing').mockImplementation(async (...args) => {
            await real(...args)
            if (++calls === 2) lose()
          })
        } else if (operation === 'move') {
          const real = disk.recheck.bind(disk)
          vi.spyOn(disk, 'recheck').mockImplementation(async (...args) => {
            await real(...args)
            lose()
          })
        } else {
          const real = disk.contained.bind(disk)
          let calls = 0
          vi.spyOn(disk, 'contained').mockImplementation(async (...args) => {
            const target = await real(...args)
            if (++calls === 2) lose()
            return target
          })
        }
        const effect =
          operation === 'write'
            ? vault.disk.writeAtomic('original.bin', new TextEncoder().encode('incoming'), 1)
            : operation === 'move'
              ? vault.disk.move('original.bin', 'target.bin')
              : vault.disk.remove('original.bin')
        await expect(effect).rejects.toMatchObject({ code: 'lost' })
        expect(readFileSync(join(dir, 'original.bin'), 'utf8')).toBe('original')
        expect(existsSync(join(dir, 'target.bin'))).toBe(false)
        if (operation === 'write')
          expect(readdirSync(join(stateFolder(dir), 'tmp')).length).toBeGreaterThan(0)
        expect(() => vault.disk.removeTemp()).toThrow()
      } finally {
        vault.close()
        lock()
      }
    })
  it('waits for tracked predecessor effects before completing successor recovery', async () => {
    const firstLock = await acquireLock(dir),
      first = openVault(dir, ctx(), firstLock.held)
    await recoverVault(first, firstLock.held)
    let release!: () => void
    const pending = first.fence!.track(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    first.close()
    firstLock()
    const nextLock = await acquireLock(dir),
      next = openVault(dir, ctx(), nextLock.held)
    const engine = buildEngine(next, { stillHeld: nextLock.held, fallbackMs: 1000, log: () => {} })
    let ready = false
    const recovering = recoverVault(next, nextLock.held).then(() => {
      ready = true
    })
    try {
      await Promise.resolve()
      expect(ready).toBe(false)
      await expect(engine.recordScope()).rejects.toMatchObject({ reason: 'recovery-required' })
      release()
      await pending
      await recovering
      await expect(engine.recordScope()).resolves.toBeUndefined()
    } finally {
      release()
      await recovering
      await engine.stop()
      next.close()
      nextLock()
    }
  })
})
