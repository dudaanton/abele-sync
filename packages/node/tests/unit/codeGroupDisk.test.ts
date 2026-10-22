import { link, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeText, selectiveDefaults, sha256 } from '@abele/sync-core'
import { CodeDraft } from '@abele/sync-node'
import { CodeGroupDisk } from '@abele/sync-node'
import { NodeFileSystem } from '@abele/sync-node'
import { SqliteStateStore } from '@abele/sync-node'
import type { DaemonConfig } from '../../src/config.js'

const MAIN = '.obsidian/plugins/sample/main.js'
const MANIFEST = '.obsidian/plugins/sample/manifest.json'
let dir: string, disk: NodeFileSystem, state: SqliteStateStore
const cfg: DaemonConfig = {
  serverUrl: 'https://sync.example.test',
  vaultId: 'vault',
  deviceId: 'device',
  deviceToken: 'absd_test',
  deviceName: 'Test',
  selective: selectiveDefaults(),
}
const vault = () => ({ dir, disk, state, cfg })
const text = async (path: string) => new TextDecoder().decode(await disk.read(path))
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'abele-group-'))
  disk = new NodeFileSystem(dir)
  state = SqliteStateStore.open(join(dir, '.abele-sync/state.db'))
  state.setMeta('test-queue', 'pending')
  await disk.writeAtomic(MAIN, encodeText('original()'), 1)
})
afterEach(async () => {
  state.close()
  await rm(dir, { recursive: true, force: true })
})

async function prepared() {
  const group = await CodeGroupDisk.create(vault(), () => true)
  const draft = await CodeDraft.create(disk, group.work)
  await draft.preload([MAIN, MANIFEST])
  await draft.writeAtomic(MAIN, encodeText('approved()'), 2)
  await draft.writeAtomic(MANIFEST, encodeText('{"version":"2.0.0"}'), 2)
  return { group, draft }
}

describe('grouped code placement recovery', () => {
  it('D-089 retries a valid rollback after a one-shot ledger identity read failure', async () => {
    const { group, draft } = await prepared()
    await expect(
      state.transaction(async (tx) => {
        await group.place(draft, tx)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    const journal = await new NodeFileSystem(group.work).read('journal.json')
    const read = state.readExternalInstanceId.bind(state)
    const failure = Object.assign(new Error('transient database read'), { code: 'SQLITE_IOERR' })
    let once = true
    state.readExternalInstanceId = () => {
      if (once) {
        once = false
        throw failure
      }
      return read()
    }
    await expect(CodeGroupDisk.recover(vault(), () => true)).rejects.toBe(failure)
    expect(CodeGroupDisk.reviews(vault())).toEqual([])
    expect(await new NodeFileSystem(group.work).read('journal.json')).toEqual(journal)
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('original()')
    expect(await disk.stat(MANIFEST)).toBeNull()
    expect(CodeGroupDisk.reviews(vault())).toEqual([])
  })
  it('D-087 records the requested folded spelling rather than an earlier unrelated hard-link alias', async () => {
    const alias = '.obsidian/plugins/sample/aaa.js'
    await link(join(dir, MAIN), join(dir, alias))
    const children = disk.listChildren.bind(disk)
    disk.listChildren = async (parent) =>
      (await children(parent)).sort((a, b) => a.path.localeCompare(b.path))
    const { group, draft } = await prepared()
    await expect(
      state.transaction(async (tx) => {
        await group.place(draft, tx)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    const files = new NodeFileSystem(group.work)
    const journal = JSON.parse(new TextDecoder().decode(await files.read('journal.json')))
    expect(journal.steps[0].spelling[MAIN]).toBe(MAIN)
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('original()')
    expect(await text(alias)).toBe('original()')
    expect(await readdir(join(dir, '.abele-sync/code-approvals'))).toEqual([])
  })

  it.each(['{invalid', '{"version":2}'])(
    'retains an invalid journal (%s) and its backup under one durable review record without blocking restart',
    async (invalid) => {
      const { group, draft } = await prepared()
      await expect(
        state.transaction(async (tx) => {
          await group.place(draft, tx)
          throw new Error('stop')
        })
      ).rejects.toThrow('stop')
      const files = new NodeFileSystem(group.work)
      await files.writeAtomic('journal.json', encodeText(invalid), 0)
      await CodeGroupDisk.recover(vault(), () => true)
      const keys = state.metadataKeys('code-approval-review:')
      expect(keys).toHaveLength(1)
      const record = JSON.parse(state.getMeta(keys[0]!)!)
      const retained = new NodeFileSystem(join(dir, record.path))
      expect(new TextDecoder().decode(await retained.read('journal.json'))).toBe(invalid)
      expect(await readdir(join(dir, record.path, 'blobs'))).not.toHaveLength(0)
      expect(await retained.read(`blobs/${await sha256(encodeText('original()'))}`)).toEqual(
        encodeText('original()')
      )
      expect(await text(MAIN)).toBe('approved()')
      await CodeGroupDisk.recover(vault(), () => true)
      expect(state.metadataKeys('code-approval-review:')).toEqual(keys)
      expect(state.getMeta(keys[0]!)).toBe(JSON.stringify(record))
    }
  )
  it('does not undo an unrelated replacement inode even when its bytes equal the move result', async () => {
    const group = await CodeGroupDisk.create(vault(), () => true)
    const draft = await CodeDraft.create(disk, group.work)
    await draft.move(MAIN, MANIFEST)
    await expect(
      state.transaction(async (tx) => {
        await group.place(draft, tx)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    await disk.writeAtomic(MANIFEST, encodeText('original()'), 1)
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('original()')
    expect(await text(MANIFEST)).toBe('original()')
  })
  it('refuses a save at the final group publication boundary', async () => {
    const { group, draft } = await prepared()
    const write = disk.writeAtomic.bind(disk),
      conditional = disk.conditionalFile.bind(disk)
    let injected = false
    const save = async (path: string) => {
      if (path === MAIN && !injected) {
        injected = true
        await write(MAIN, encodeText('local edit'), 1)
      }
    }
    disk.writeAtomic = async (path, bytes, mtime) => {
      await save(path)
      await write(path, bytes, mtime)
    }
    disk.conditionalFile = async (op) => {
      await save(op.path)
      return conditional(op)
    }
    await expect(state.transaction((tx) => group.place(draft, tx))).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(await text(MAIN)).toBe('local edit')
  })

  it('records conditional operations in the speculative draft only', async () => {
    const group = await CodeGroupDisk.create(vault(), () => true)
    const draft = await CodeDraft.create(disk, group.work)
    expect(
      await draft.conditionalFile?.({
        path: MANIFEST,
        expected: null,
        effect: { kind: 'write', bytes: encodeText('new'), mtime: 2 },
      })
    ).toBe(true)
    expect(draft.steps).toHaveLength(1)
    expect(await disk.stat(MANIFEST)).toBeNull()
    await state.transaction((tx) => group.place(draft, tx))
    expect(await text(MANIFEST)).toBe('new')
  })
  it('retains legacy journals without ledger ownership evidence', async () => {
    const { group, draft } = await prepared()
    await state.transaction((tx) => group.place(draft, tx))
    const files = new NodeFileSystem(group.work)
    const journal = JSON.parse(new TextDecoder().decode(await files.read('journal.json')))
    delete journal.ledger
    await files.writeAtomic('journal.json', encodeText(JSON.stringify(journal)), 0)
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('approved()')
    const reviews = CodeGroupDisk.reviews(vault())
    expect(reviews).toHaveLength(1)
    expect(await readdir(join(dir, reviews[0]!.path))).toContain('journal.json')
  })

  it.each([true, false])(
    'requires ownership to apply a journal but preserves it for review without blocking (committed: %s)',
    async (committed) => {
      const { group, draft } = await prepared()
      if (committed) await state.transaction((tx) => group.place(draft, tx))
      else
        await expect(
          state.transaction(async (tx) => {
            await group.place(draft, tx)
            throw new Error('interrupted')
          })
        ).rejects.toThrow('interrupted')
      const journal = await new NodeFileSystem(group.work).read('journal.json')
      const other = SqliteStateStore.open(join(dir, 'other-state/state.db'))
      try {
        await CodeGroupDisk.recover({ ...vault(), state: other }, () => true)
        expect(await text(MAIN)).toBe('approved()')
        const reviews = CodeGroupDisk.reviews({ state: other })
        expect(reviews).toHaveLength(1)
        const retained = join(dir, reviews[0]!.path)
        expect(await new NodeFileSystem(retained).read('journal.json')).toEqual(journal)
        expect(await readdir(retained)).toContain('blobs')
      } finally {
        other.close()
      }
      await CodeGroupDisk.recover(vault(), () => true)
      expect(await text(MAIN)).toBe('approved()')
      expect(CodeGroupDisk.reviews(vault())).toHaveLength(1)
    }
  )

  it('clears an orphan commit marker before using a newly allocated workspace', async () => {
    // A cleanup can remove its directory before it manages to delete the old marker.
    const get = state.getMeta.bind(state),
      set = state.setMeta.bind(state)
    const cleared = new Set<string>()
    state.getMeta = (key) =>
      key.startsWith('code-approval:') && !cleared.has(key) ? 'committed' : get(key)
    state.setMeta = (key, value) => {
      if (value === null) cleared.add(key)
      set(key, value)
    }
    const group = await CodeGroupDisk.create(vault(), () => true)
    expect(state.getMeta(`code-approval:${basename(group.work)}`)).toBeNull()
    await group.discard()
  })

  it('undoes disk placement when SQLite did not commit and keeps the whole queue', async () => {
    const { group, draft } = await prepared()
    await expect(
      state.transaction(async (tx) => {
        await tx.setMeta!('test-queue', null)
        await group.place(draft, tx)
        throw new Error('stopped before SQLite commit')
      })
    ).rejects.toThrow('stopped before SQLite commit')
    expect(await text(MAIN)).toBe('approved()')
    expect(state.getMeta('test-queue')).toBe('pending')
    state.close()
    state = SqliteStateStore.open(join(dir, '.abele-sync/state.db'))
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('original()')
    expect(await disk.stat(MANIFEST)).toBeNull()
    expect(state.getMeta('test-queue')).toBe('pending')
    await CodeGroupDisk.recover(vault(), () => true)
  })

  it('does not undo a committed group or resurrect later local deletions when cleanup was interrupted', async () => {
    const { group, draft } = await prepared()
    await state.transaction(async (tx) => {
      await group.place(draft, tx)
      await tx.setMeta!('test-queue', null)
    })
    // A failure reported after SQLite committed must not undo the now-committed files.
    await group.rollback()
    expect(await text(MAIN)).toBe('approved()')
    await disk.remove(MAIN)
    await disk.remove(MANIFEST)
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await disk.stat(MAIN)).toBeNull()
    expect(await disk.stat(MANIFEST)).toBeNull()
    expect(state.getMeta('test-queue')).toBeNull()
    expect(state.getMeta(`code-approval:${basename(group.work)}`)).toBeNull()
  })

  it('recovers an interrupted rollback after a later placement failed', async () => {
    const { group, draft } = await prepared()
    const write = disk.conditionalFile.bind(disk)
    disk.conditionalFile = async (op) => {
      if (op.path === MANIFEST) throw new Error('cannot place')
      return write(op)
    }
    await expect(state.transaction((tx) => group.place(draft, tx))).rejects.toThrow('cannot place')
    disk.conditionalFile = write
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('original()')
    expect(await disk.stat(MANIFEST)).toBeNull()
  })

  it('rolls a case-only move back to its exact original spelling', async () => {
    const group = await CodeGroupDisk.create(vault(), () => true)
    const draft = await CodeDraft.create(disk, group.work)
    const renamed = '.obsidian/plugins/sample/Main.js'
    await draft.preload([MAIN, renamed])
    await draft.move(MAIN, renamed)
    await expect(
      state.transaction(async (tx) => {
        await group.place(draft, tx)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await readdir(join(dir, '.obsidian/plugins/sample'))).toEqual(['main.js'])
  })

  it('restores backups visibly rather than overwriting an external edit or blocking recovery', async () => {
    const { group, draft } = await prepared()
    await expect(
      state.transaction(async (tx) => {
        await group.place(draft, tx)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    await disk.writeAtomic(MAIN, encodeText('localAfterInterruption()'), 3)
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await text(MAIN)).toBe('localAfterInterruption()')
    const copies = (await readdir(join(dir, '.obsidian/plugins/sample'))).filter((name) =>
      name.startsWith('main.js.sync-conflict-')
    )
    expect(copies).toHaveLength(1)
    expect(await text(`.obsidian/plugins/sample/${copies[0]}`)).toBe('original()')
    await expect(readdir(group.work)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.getMeta('test-queue')).toBe('pending')
    await CodeGroupDisk.recover(vault(), () => true)
  })
})
