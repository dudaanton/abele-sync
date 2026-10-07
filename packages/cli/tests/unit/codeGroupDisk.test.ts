import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeText, selectiveDefaults } from '@abele/sync-core'
import { CodeDraft } from '../../src/codeDraft.js'
import { CodeGroupDisk } from '../../src/codeGroupDisk.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
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
      state.transaction(async () => {
        state.setMeta('test-queue', null)
        await group.place(draft)
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
    await state.transaction(async () => {
      await group.place(draft)
      state.setMeta('test-queue', null)
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
    const write = disk.writeAtomic.bind(disk)
    disk.writeAtomic = async (...args) => {
      if (args[0] === MANIFEST) throw new Error('cannot place')
      await write(...args)
    }
    await expect(state.transaction(() => group.place(draft))).rejects.toThrow('cannot place')
    disk.writeAtomic = write
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
      state.transaction(async () => {
        await group.place(draft)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    await CodeGroupDisk.recover(vault(), () => true)
    expect(await readdir(join(dir, '.obsidian/plugins/sample'))).toEqual(['main.js'])
  })

  it('retains backups rather than overwriting an external edit during recovery', async () => {
    const { group, draft } = await prepared()
    await expect(
      state.transaction(async () => {
        await group.place(draft)
        throw new Error('stop')
      })
    ).rejects.toThrow('stop')
    await disk.writeAtomic(MAIN, encodeText('localAfterInterruption()'), 3)
    await expect(CodeGroupDisk.recover(vault(), () => true)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(await text(MAIN)).toBe('localAfterInterruption()')
    expect(await readdir(group.work)).toContain('journal.json')
    expect(state.getMeta('test-queue')).toBe('pending')
  })
})
