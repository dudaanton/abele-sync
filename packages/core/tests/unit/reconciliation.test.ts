import { expect, it } from 'vitest'
import { validatePath } from '@abele/sync-protocol'
import {
  encodeText,
  MemoryFileSystem,
  MemoryStateStore,
  sha256,
  type EngineClient,
} from '../../src/index.js'
import {
  fenceRestoredJournal,
  preserveRestoredEdits,
  readReconciliation,
  reconciliationScan,
  requestReconciliation,
} from '../../src/reconciliation.js'

async function fixture() {
  const fs = new MemoryFileSystem()
  const state = new MemoryStateStore()
  const entry = {
    path: 'N.bin',
    wirePath: 'N.bin',
    fileId: 'file',
    versionId: 'old-version',
    sha: await sha256(encodeText('old')),
    size: 3,
    mtime: 10,
  }
  await state.put(entry)
  await state.setCursor(10)
  await fs.writeAtomic(entry.path, encodeText('old'), entry.mtime)
  return { fs, state, entry }
}
const all = { excluded: () => false }

it('does not overwrite a save at the restored conflict destination during download', async () => {
  const { fs, state, entry } = await fixture()
  const sha = await sha256(encodeText('remote'))
  const path = `N (Conflicted copy remote ${sha.slice(0, 16)}).bin`
  const client = {
    versions: async () => [{ version_id: 'new', sha, size: 6, mtime: 20 }],
    versionBytes: async () => {
      await fs.writeAtomic(path, encodeText('saved'), 30)
      return encodeText('remote')
    },
  } as unknown as EngineClient
  await preserveRestoredEdits(client, fs, state, {
    ops: [
      {
        op: 'modify',
        file_id: entry.fileId,
        base_version_id: entry.versionId,
        sha: await sha256(encodeText('local')),
        size: 5,
        mtime: 30,
      },
    ],
  } as Parameters<typeof preserveRestoredEdits>[3])
  expect(await fs.read(path)).toEqual(encodeText('saved'))
  expect(await fs.read(`N (Conflicted copy remote ${sha.slice(0, 16)} 1).bin`)).toEqual(
    encodeText('remote')
  )
})

it.each([
  ['Café/'.normalize('NFD'), false],
  [('é'.repeat(100) + '/').repeat(4).normalize('NFD'), false],
  [('é'.repeat(100) + '/').repeat(5).normalize('NFD'), true],
] as const)(
  'keeps physical recovery parents and fits NFC wire lengths: %s',
  async (folder, rootFallback) => {
    for (const localMtime of [1, 30]) {
      const { fs, state, entry } = await fixture()
      await fs.remove(entry.path)
      await state.delete(entry.path)
      const path = folder + 'N.bin'
      await state.put({ ...entry, path, wirePath: path.normalize('NFC') })
      await fs.writeAtomic(path, encodeText('local'), localMtime)
      await requestReconciliation(state)
      const { found } = await reconciliationScan(fs, state, all, 11)
      const client = {
        versions: async () => [
          { version_id: 'remote', sha: await sha256(encodeText('remote')), size: 6, mtime: 20 },
        ],
        versionBytes: async () => encodeText('remote'),
      } as unknown as EngineClient
      await preserveRestoredEdits(client, fs, state, found)
      await preserveRestoredEdits(client, fs, state, found)
      const copies = []
      for await (const info of fs.list()) if (info.path !== path) copies.push(info.path)
      expect(copies).toHaveLength(1)
      const copy = copies[0]!
      expect(copy.slice(0, copy.lastIndexOf('/') + 1)).toBe(rootFallback ? '' : folder)
      expect(() => validatePath(copy.normalize('NFC'))).not.toThrow()
      expect(await fs.read(copy)).toEqual(encodeText(localMtime > 20 ? 'remote' : 'local'))
      expect(await fs.read(path)).toEqual(encodeText('local'))
    }
  }
)

it('accounts for proven committed deletes exactly once while archiving rather than replaying a stale journal', async () => {
  const { state, fs } = await fixture()
  const journal = {
    batchId: 'b',
    idempotencyKey: 'committed',
    startedAt: '2026-10-16T00:00:00Z',
    ops: [{ op: 'delete' as const, file_id: 'file', base_version_id: 'old-version' }],
  }
  await state.setJournal(journal)
  let reads = 0
  const client = {
    versions: async () => {
      reads++
      return [{ op: 'delete', version_id: 'deleted' }, { version_id: 'old-version' }]
    },
  } as unknown as EngineClient
  await fenceRestoredJournal(state, 11, fs, undefined, client)
  // A persisted recovery slot can be presented again with the same idempotency key.
  await state.setJournal(journal)
  await fenceRestoredJournal(state, 11, fs, undefined, client)
  expect(reads).toBe(1)
  expect(await state.getJournal()).toBeNull()
  expect(JSON.parse((await state.getMeta('reconciliation-journal:committed'))!)).toEqual(journal)
  const recent = JSON.parse((await state.getMeta('recent-deletes'))!) as [number, number][]
  expect(recent.reduce((sum, [, count]) => sum + count, 0)).toBe(1)
})

it('does not interpret a single backdated binary edit as a restored vault on restart', async () => {
  const { fs, state } = await fixture()
  await fs.writeAtomic('N.bin', encodeText('new'), 1)
  const result = await reconciliationScan(fs, state, all, 11)
  expect(result.reconciliation).toBeNull()
  expect(result.found.ops).toContainEqual(expect.objectContaining({ op: 'modify' }))
})

it('protects a backdated binary divergence even beside unchanged files with backdated timestamps', async () => {
  const { fs, state, entry } = await fixture()
  await fs.writeAtomic(entry.path, encodeText('new'), 1)
  await state.put({ ...entry, path: 'Other.bin', wirePath: 'Other.bin', fileId: 'other' })
  await fs.writeAtomic('Other.bin', encodeText('old'), 1)
  const client = {
    versions: async () => [{ version_id: 'newer-version', sha: 'remote', mtime: 0 }],
  } as unknown as EngineClient
  const result = await reconciliationScan(fs, state, all, 11, undefined, undefined, true, client)
  expect(result.reconciliation?.phase).toBe('requested')
})

it('does not treat staged plugin sources or settled absence as evidence of a restore', async () => {
  const { fs, state, entry } = await fixture()
  const staged = []
  for (const [index, name] of ['main.js', 'manifest.json', 'styles.css'].entries()) {
    const path = `.obsidian/plugins/example/${name}`
    const file = { ...entry, path, wirePath: path, fileId: `plugin-${index}` }
    await state.put(file)
    await fs.writeAtomic(path, encodeText('new'), 1)
    staged.push({
      base: file.versionId,
      change: { file_id: file.fileId, path, version_id: 'remote', seq: 11 },
    })
  }
  await state.setMeta('deferred-changes', JSON.stringify({ staged }))
  expect((await reconciliationScan(fs, state, all, 11)).reconciliation).toBeNull()
  await fs.remove('.obsidian/plugins/example/main.js')
  expect((await reconciliationScan(fs, state, all, 11)).reconciliation).toBeNull()
})

it('does not mistake a backwards timestamp on unchanged bytes for restored edits', async () => {
  const { fs, state, entry } = await fixture()
  await fs.writeAtomic(entry.path, encodeText('old'), 1)
  await state.put({ ...entry, path: 'Other.bin', wirePath: 'Other.bin', fileId: 'other' })
  await fs.writeAtomic('Other.bin', encodeText('old'), 1)
  expect((await reconciliationScan(fs, state, all, 11)).reconciliation).toBeNull()
})

it('stops a restored destructive directory journal without changing its protocol document', async () => {
  const { fs, state } = await fixture()
  const raw = JSON.stringify({
    directories: [],
    pending: {
      key: 'old-key',
      op: { op: 'delete_directory', file_id: 'folder', base_version_id: 'old' },
    },
  })
  await state.setMeta('v2-directories', raw)
  await expect(reconciliationScan(fs, state, all, 11)).rejects.toThrow(
    'directory journal preserved'
  )
  expect(await state.getMeta('v2-directories')).toBe(raw)
  expect((await readReconciliation(state))?.phase).toBe('requested')
})

it('requires fresh review when a restored snapshot already contains an active reconciliation and confirmation', async () => {
  const { state, fs } = await fixture()
  await state.setMeta(
    'content-reconciliation',
    JSON.stringify({ phase: 'review', reason: 'old review' })
  )
  await state.setMeta(
    'delete-decision',
    JSON.stringify({ kind: 'confirm', fileIds: ['file'], at: 'old confirmation' })
  )
  await fs.remove('N.bin')
  await reconciliationScan(fs, state, all, 11)
  expect(await state.getMeta('delete-decision')).toBeNull()
})

it('preserves a mixed destructive journal and stops when its unsent bytes cannot be recovered from disk', async () => {
  const { state } = await fixture()
  const journal = {
    batchId: 'batch',
    idempotencyKey: 'mixed',
    startedAt: '2026-10-16T00:00:00Z',
    ops: [
      { op: 'delete' as const, file_id: 'file', base_version_id: 'old-version' },
      {
        op: 'create' as const,
        path: 'unsent.bin',
        sha: await sha256(encodeText('unsent')),
        size: 6,
        mtime: 1,
      },
    ],
  }
  await state.setJournal(journal)
  await expect(fenceRestoredJournal(state, 11)).rejects.toThrow('unsent bytes')
  expect(await state.getJournal()).toEqual(journal)
})

it('recognizes missing then reappearing tracked content even with unchanged metadata', async () => {
  const { fs, state } = await fixture()
  await fs.remove('N.bin')
  await reconciliationScan(fs, state, all, 10)
  expect(await readReconciliation(state)).toBeNull()
  await fs.writeAtomic('N.bin', encodeText('new'), 10)
  const result = await reconciliationScan(fs, state, all, 10)
  expect(result.reconciliation?.reason).toContain('reappeared')
  expect(result.found.ops).toContainEqual(
    expect.objectContaining({ op: 'modify', sha: await sha256(encodeText('new')) })
  )
})

it('preserves the exact destructive journal if archiving fails and retries without replay', async () => {
  const { state } = await fixture()
  const journal = {
    batchId: 'batch',
    idempotencyKey: 'receipt',
    startedAt: '2026-10-16T00:00:00Z',
    ops: [{ op: 'delete' as const, file_id: 'file', base_version_id: 'old-version' }],
  }
  await state.setJournal(journal)
  const setMeta = state.setMeta.bind(state)
  state.setMeta = async (key, value) => {
    if (key.startsWith('reconciliation-journal:')) throw new Error('disk full')
    await setMeta(key, value)
  }
  await expect(fenceRestoredJournal(state, 11)).rejects.toThrow('disk full')
  expect(await state.getJournal()).toEqual(journal)
  state.setMeta = setMeta
  await fenceRestoredJournal(state, 11)
  expect(await state.getJournal()).toBeNull()
  expect(JSON.parse((await state.getMeta('reconciliation-journal:receipt'))!)).toEqual(journal)
})

it('does not duplicate or overwrite recovery copies after a write succeeded before a crash', async () => {
  const { fs, state } = await fixture()
  await fs.writeAtomic('N.bin', encodeText('new'), 1)
  await requestReconciliation(state)
  const { found } = await reconciliationScan(fs, state, all, 11)
  const client = {
    versions: async () => [{ version_id: 'new-version', sha: 'different' }],
  } as unknown as EngineClient
  const write = fs.writeAtomic.bind(fs)
  fs.writeAtomic = async (path, bytes, mtime) => {
    await write(path, bytes, mtime)
    throw new Error('crash after write')
  }
  await expect(preserveRestoredEdits(client, fs, state, found)).rejects.toThrow('crash after write')
  fs.writeAtomic = write
  await preserveRestoredEdits(client, fs, state, found)
  const files = []
  for await (const info of fs.list()) files.push(info.path)
  expect(files).toHaveLength(2)
  for (const path of files) expect(await fs.read(path)).toEqual(encodeText('new'))
})

it('stops an incomplete full content reconciliation instead of calling unreadable content verified', async () => {
  const { fs, state } = await fixture()
  await requestReconciliation(state)
  fs.read = async () => {
    throw new Error('unreadable')
  }
  await expect(reconciliationScan(fs, state, all, 10)).rejects.toThrow('incomplete')
  expect((await readReconciliation(state))?.phase).toBe('requested')
})
