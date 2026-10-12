import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  applyStaged,
  ExpectedWrites,
  MemoryStateStore,
  sha256,
  push,
  scan,
  recoverPendingPullWrites,
  type EngineClient,
} from '@abele/sync-core'
import type { ChangeItem } from '@abele/sync-protocol'
import { NodeFileSystem } from '../../src/nodeFs.js'

it('normal hydration streams an immutable version directly to a durable stage', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stream-pull-'))
  try {
    const fs = new NodeFileSystem(root)
    const bytes = new Uint8Array(1024 * 1024 + 7).fill(4)
    const sha = await sha256(bytes)
    const state = new MemoryStateStore()
    let closed = false
    const client = {
      async getBlob() {
        throw new Error('whole response forbidden')
      },
      async openVersion(file: string, version: string) {
        expect([file, version]).toEqual(['f', 'v'])
        return {
          size: bytes.length,
          async read(at: number, length: number) {
            expect(length).toBeLessThanOrEqual(1024 * 1024)
            return bytes.slice(at, at + length)
          },
          async assertUnchanged() {},
          async close() {
            closed = true
          },
        }
      },
    } as unknown as EngineClient
    const change: ChangeItem = {
      seq: 1,
      file_id: 'f',
      version_id: 'v',
      op: 'create',
      path: 'file.bin',
      prev_path: null,
      sha,
      size: bytes.length,
      mtime: 1000,
      kind: 'attachment',
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    fs.read = async () => {
      throw new Error('whole file read forbidden')
    }
    const result = await applyStaged(client, fs, state, [change], {
      filter: { excluded: () => false },
      dirty: new Set(),
      expected: new ExpectedWrites(),
    })
    expect(result.applied).toBe(1)
    expect((await fs.fingerprint('file.bin')).sha).toBe(sha)
    expect(closed).toBe(true)
    expect(await state.getMeta('pull-write:f')).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const phase of ['download', 'seal', 'move', 'publish'] as const) {
  it(`recovers a streamed remote move interrupted at ${phase} before scanning`, async () => {
    const root = await mkdtemp(join(process.cwd(), '.stream-recovery-'))
    try {
      const fs = new NodeFileSystem(root)
      const state = new MemoryStateStore()
      const original = new Uint8Array([1])
      await fs.writeAtomic('old.bin', original, 1000)
      const info = (await fs.stat('old.bin'))!
      await state.put({
        wirePath: 'old.bin',
        fileId: 'f',
        versionId: 'base',
        sha: await sha256(original),
        ...info,
      })
      const bytes = new Uint8Array(1024 * 1024 + 7).fill(4)
      const sha = await sha256(bytes)
      let interrupt = true
      const offsets: number[] = []
      const client = {
        async getBlob() {
          throw new Error('whole response forbidden')
        },
        async openVersion() {
          return {
            size: bytes.length,
            async read(at: number, length: number) {
              offsets.push(at)
              if (phase === 'download' && interrupt && at > 0) throw new Error('crash')
              return bytes.slice(at, at + length)
            },
            async assertUnchanged() {},
            async close() {},
          }
        },
      } as unknown as EngineClient
      const begin = fs.beginAtomicWrite.bind(fs)
      fs.beginAtomicWrite = async (...args) => {
        const stage = await begin(...args)
        return new Proxy(stage, {
          get(target, key) {
            if (key === 'seal' || key === 'commit')
              return async (...args: unknown[]) => {
                await (target[key] as (...args: unknown[]) => Promise<void>)(...args)
                if (
                  interrupt &&
                  ((phase === 'seal' && key === 'seal') ||
                    (phase === 'publish' && key === 'commit'))
                )
                  throw new Error('crash')
              }
            return Reflect.get(target, key)
          },
        })
      }
      const move = fs.move.bind(fs)
      fs.move = async (...args) => {
        await move(...args)
        if (phase === 'move' && interrupt) throw new Error('crash')
      }
      const change: ChangeItem = {
        seq: 1,
        file_id: 'f',
        version_id: 'v',
        op: 'move',
        path: 'new.bin',
        prev_path: 'old.bin',
        sha,
        size: bytes.length,
        mtime: 2000,
        kind: 'attachment',
        actor: { kind: 'system', id: 'test', name: 'test' },
        at: '',
      }
      await expect(
        applyStaged(client, fs, state, [change], {
          filter: { excluded: () => false },
          dirty: new Set(),
          expected: new ExpectedWrites(),
        })
      ).rejects.toThrow('crash')
      interrupt = false
      const restarted = new NodeFileSystem(root)
      await recoverPendingPullWrites(restarted, state, ['f'], client)
      expect(await restarted.stat('old.bin')).toBeNull()
      expect((await restarted.fingerprint('new.bin')).sha).toBe(sha)
      expect((await state.byFileId('f'))?.versionId).toBe('v')
      expect(await state.getMeta('pull-write:f')).toBeNull()
      if (phase === 'download') expect(offsets).toEqual([0, 1024 * 1024, 1024 * 1024])
      expect((await scan(restarted, state, { excluded: () => false })).dirty.size).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

it('streams a merged push verdict without prefetching whole conflict content', async () => {
  const root = await mkdtemp(join(process.cwd(), '.stream-verdict-'))
  try {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('file.bin', new Uint8Array([1]), 1000)
    const bytes = new Uint8Array(1024 * 1024 + 7).fill(4)
    const sha = await sha256(bytes)
    const state = new MemoryStateStore()
    const result = {
      status: 'merged',
      file_id: 'f',
      version_id: 'remote',
      path: 'file.bin',
      sha,
      size: bytes.length,
      mtime: 2000,
      seq: 1,
    }
    const client = {
      async hasBlob() {
        return true
      },
      async commitRaw() {
        return { body: { head_seq: 1, results: [result] }, replayed: false }
      },
      async getBlob() {
        throw new Error('whole verdict forbidden')
      },
      async openVersion() {
        return {
          size: bytes.length,
          async read(at: number, length: number) {
            expect(length).toBeLessThanOrEqual(1024 * 1024)
            return bytes.slice(at, at + length)
          },
          async assertUnchanged() {},
          async close() {},
        }
      },
    } as unknown as EngineClient
    fs.read = async () => {
      throw new Error('whole file forbidden')
    }
    const filter = { excluded: () => false }
    const report = await push(client, fs, state, await scan(fs, state, filter), {
      expected: new ExpectedWrites(),
      filter,
    })
    expect(report.merged).toBe(1)
    expect((await fs.fingerprint('file.bin')).sha).toBe(sha)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
