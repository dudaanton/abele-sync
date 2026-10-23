import { mkdtemp, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NodeFileSystem } from '@abele/sync-node'
import { V2Directories } from '../../src/v2Directories.js'
import { MemoryStateStore } from '../../src/state.js'
import { sha256 } from '../../src/hash.js'
import type { V2CommitOp } from '@abele/sync-protocol'

it.each(['replacement', 'recycled', 'corroborated'] as const)(
  'native directory evidence protects identities (%s)',
  async (mode) => {
    const root = await mkdtemp(join(process.cwd(), '.directory-evidence-'))
    try {
      const fs = new NodeFileSystem(root),
        state = new MemoryStateStore()
      const bytes = new Uint8Array([1, 2, 3]),
        sha = await sha256(bytes)
      await fs.writeAtomic('source/child.md', bytes, 1000)
      await mkdir(join(root, 'target'))
      const original = []
      for await (const dir of fs.listDirectories()) original.push(dir)
      const source = original.find((d) => d.path === 'source')!
      const target = original.find((d) => d.path === 'target')!
      const tracked = [source, ...(mode === 'replacement' ? [target] : [])].map((d) => ({
        file_id: d.path,
        version_id: 'v1',
        kind: 'directory',
        ...d,
        localPath: d.path,
      }))
      await state.setMeta(
        'v2-directories',
        JSON.stringify({ schemaVersion: 2, directories: tracked, removals: [] })
      )
      await state.setCursor(1)
      await state.put({
        path: 'source/child.md',
        wirePath: 'source/child.md',
        fileId: 'child',
        versionId: 'v1',
        sha,
        size: 3,
        mtime: 1000,
      })
      const destination = mode === 'replacement' ? 'target' : 'fresh'
      if (mode === 'replacement') await rename(join(root, 'source'), join(root, 'target'))
      else if (mode === 'corroborated') await rename(join(root, 'source'), join(root, 'fresh'))
      else {
        await rm(join(root, 'source'), { recursive: true })
        await fs.writeAtomic('fresh/child.md', new Uint8Array([4, 5, 6]), 1000)
        const list = fs.listDirectories.bind(fs)
        fs.listDirectories = async function* () {
          for await (const d of list())
            yield d.path === 'fresh' ? { ...d, identity: source.identity } : d
        }
      }
      const observed = []
      for await (const d of fs.listDirectories()) observed.push(d)
      expect(observed.find((d) => d.path === destination)?.identity).toBe(source.identity)
      const sent: V2CommitOp[] = []
      await new V2Directories(
        fs,
        state,
        () => true,
        async (ops) => {
          sent.push(...ops)
          return ops.map((op) => ({
            status: 'applied',
            file_id: op.op === 'mkdir' ? 'new-' + op.path : 'source',
            version_id: 'v2',
            path: op.op === 'mkdir' ? op.path : destination,
            mtime: 1,
            seq: 2,
          })) as never
        }
      ).scan()
      expect(sent).not.toContainEqual(
        expect.objectContaining({ op: 'delete_directory', file_id: 'source' })
      )
      if (mode === 'corroborated')
        expect(sent).toContainEqual(
          expect.objectContaining({ op: 'move_directory', file_id: 'source', to_path: destination })
        )
      else expect(sent).not.toContainEqual(expect.objectContaining({ op: 'move_directory' }))
      if (mode !== 'corroborated')
        expect(JSON.parse((await state.getMeta('v2-directories'))!).directories).toContainEqual(
          tracked[0]
        )
      expect(await fs.read(destination + '/child.md')).toEqual(
        mode === 'recycled' ? new Uint8Array([4, 5, 6]) : bytes
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('native conditional source identity refuses equal bytes recreated with the same mtime', async () => {
  const root = await mkdtemp(join(process.cwd(), '.source-evidence-'))
  try {
    const fs = new NodeFileSystem(root),
      bytes = new Uint8Array([1, 2, 3])
    await fs.writeAtomic('source', bytes, 1000)
    const identity = await fs.fileIdentity('source')
    expect(identity).not.toBeNull()
    const before = (await fs.stat('source'))!
    // Keep the unlinked inode alive so this fixture deterministically creates
    // a different identity, even on a filesystem that immediately recycles it.
    const original = await open(join(root, 'source'), 'r')
    try {
      await fs.remove('source')
      await fs.writeAtomic('source', bytes, 1000)
      expect(await fs.fileIdentity('source')).not.toBe(identity)
    } finally {
      await original.close()
    }
    expect(
      await fs.conditionalFile({
        path: 'source',
        expected: { ...before, sha: await sha256(bytes), identity: identity! },
        effect: { kind: 'move', to: 'target' },
      })
    ).toBe(false)
    expect(await fs.read('source')).toEqual(bytes)
    expect(await fs.stat('target')).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
