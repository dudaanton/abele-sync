import { mkdtemp, rm, open, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256, retentionSnapshot, recoverRemovals } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { retentionHandedOver } from '../../src/removalSafety.js'

it('refuses an expected-absent removal of an occupied name without recursive capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removal-absence-'))
  try {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', new Uint8Array([1]), 1)
    expect(
      await fs.conditionalFile({ path: 'a.md', expected: null, effect: { kind: 'remove' } })
    ).toBe(false)
    expect(await fs.read('a.md')).toEqual(new Uint8Array([1]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['write', 'stage'] as const)(
  'retains a displaced %s victim until owner acknowledgement and protects late writes',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'publication-retention-'))
    try {
      const fs = new NodeFileSystem(root),
        original = new Uint8Array([1]),
        next = new Uint8Array([3])
      await fs.writeAtomic('a.md', original, 1)
      const expected = { ...(await fs.stat('a.md'))!, sha: await sha256(original) }
      const writer = await open(join(root, 'a.md'), 'r+')
      try {
        let acknowledge: () => Promise<void>
        if (kind === 'write') {
          expect(
            await fs.conditionalFile({
              path: 'a.md',
              expected,
              effect: { kind: 'write', bytes: next, mtime: 2, receipt: 'receipt' },
            })
          ).toBe(true)
          acknowledge = () => fs.discardInstallation('receipt')
        } else {
          const stage = await fs.beginAtomicWrite('a.md', 2, expected)
          await stage.append(0, next)
          await stage.seal({ size: 1, sha: await sha256(next) })
          await stage.commit()
          acknowledge = () => stage.discard()
        }
        const [row] = await retentionSnapshot(fs)
        expect(row).toBeDefined()
        await recoverRemovals(fs, undefined, { now: () => row!.capturedAt + 8 * 86400000 })
        expect(await retentionSnapshot(fs)).toHaveLength(1)
        await writer.write(new Uint8Array([2]), 0, 1, 0)
        await acknowledge()
        await recoverRemovals(fs, undefined, { now: () => row!.capturedAt + 8 * 86400000 })
        expect(await fs.read('a.md')).toEqual(next)
        expect(await fs.read(`a.md.sync-conflict-${row!.id}`)).toEqual(new Uint8Array([2]))
        expect(await retentionSnapshot(fs)).toEqual([])
      } finally {
        await writer.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('retains the captured inode and preserves an open-descriptor write after authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removal-retention-'))
  try {
    const fs = new NodeFileSystem(root),
      bytes = new Uint8Array([1])
    await fs.writeAtomic('a.md', bytes, 1)
    const expected = {
      ...(await fs.stat('a.md'))!,
      sha: await sha256(bytes),
      identity: (await fs.fileIdentity('a.md'))!,
    }
    const writer = await open(join(root, 'a.md'), 'r+')
    try {
      expect(
        await fs.conditionalFile({
          path: 'a.md',
          expected,
          effect: { kind: 'remove' },
          authorize: async () => true,
        })
      ).toBe(true)
      const [row] = await retentionSnapshot(fs)
      expect(row).toBeDefined()
      await writer.write(new Uint8Array([2]), 0, 1, 0)
      await recoverRemovals(fs, undefined, { now: () => row!.capturedAt + 8 * 86400000 })
      expect(await fs.read('a.md')).toEqual(new Uint8Array([2]))
      expect(await retentionSnapshot(fs)).toEqual([])
    } finally {
      await writer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('hands committed retention to a local owner without permitting unknown artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removal-handover-'))
  try {
    const fs = new NodeFileSystem(root)
    await fs.writeAtomic('a.md', new Uint8Array([1]), 1)
    await fs.conditionalFile({
      path: 'a.md',
      expected: { ...(await fs.stat('a.md'))!, sha: await sha256(new Uint8Array([1])) },
      effect: { kind: 'remove' },
    })
    expect(retentionHandedOver(join(root, '.abele-sync/retained-removals'))).toBe(true)
    await fs.writeAtomic('.abele-sync/retained-removals/unknown/data', new Uint8Array([9]), 1)
    expect(retentionHandedOver(join(root, '.abele-sync/retained-removals'))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('adopts legacy unowned retained bytes by restoring or exposing a conflict copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removal-legacy-'))
  try {
    await mkdir(join(root, '.abele-sync/retained-removals/legacy'), { recursive: true })
    await writeFile(join(root, '.abele-sync/retained-removals/legacy/a.md'), new Uint8Array([2]))
    await writeFile(join(root, 'a.md'), new Uint8Array([1]))
    const fs = new NodeFileSystem(root)
    await fs.recoverConditionalFiles()
    expect(new Uint8Array(await readFile(join(root, 'a.md.sync-conflict-legacy')))).toEqual(
      new Uint8Array([2])
    )
    expect(await fs.read('a.md')).toEqual(new Uint8Array([1]))
    await fs.recoverConditionalFiles()
    expect(await retentionSnapshot(fs)).toEqual([])
    expect(retentionHandedOver(join(root, '.abele-sync/retained-removals'))).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
