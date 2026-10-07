import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { selectiveDefaults, type SelectiveSettings, type VaultClient } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge } from '../helpers/device.js'

/**
 * A device's scope narrowed and widened again: a folder skipped and taken back, the size cap
 * lowered and raised. Whatever happened to a file while it was out of scope here, widening must
 * never turn its absence into a delete everywhere (three-node report, B2).
 */

let h: Harness, account: string

interface Vault {
  observer: VaultClient
  device(name: string, selective?: SelectiveSettings): Promise<Device>
  /**
   * The same device rebuilt under other settings, as a host does on a scope change: its token,
   * disk and state, and nothing the old engine held in memory.
   */
  rebuild(device: Device, selective: SelectiveSettings): Device
  paths(): Promise<string[]>
}

async function vault(name: string): Promise<Vault> {
  const { vaultId } = await h.vault(account, name)
  const observer = h.clientFor((await h.device(account, vaultId, 'observer')).deviceToken, vaultId)
  return {
    observer,
    device: async (device, selective) => {
      const { deviceToken } = await h.device(account, vaultId, device)
      return new Device(h, vaultId, deviceToken, device, selective ? { selective } : {})
    },
    rebuild: (device, selective) =>
      new Device(h, vaultId, device.deviceToken, device.name, {
        selective,
        fs: device.fs,
        state: device.state,
      }),
    paths: async () => (await observer.manifest(null)).items.map((item) => item.path),
  }
}

const skipping = (...folders: string[]): SelectiveSettings => ({
  ...selectiveDefaults(),
  excludedFolders: folders,
})
const capped = (bytes: number | null): SelectiveSettings => ({
  ...selectiveDefaults(),
  maxFileBytes: bytes,
})

/** Two devices holding `Burst/x.md`, `Burst/y.md` and `note.md`, all synced. */
async function burst(name: string): Promise<{ v: Vault; a: Device; b: Device }> {
  const v = await vault(name)
  const a = await v.device('a')
  const b = await v.device('b')
  await a.write('Burst/x.md', 'x\n')
  await a.write('Burst/y.md', 'y\n')
  await a.write('note.md', 'note\n')
  await a.sync()
  await b.sync()
  expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
  return { v, a, b }
}

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

describe('a file deleted here while out of scope', () => {
  it('a skipped folder taken back fetches the server’s copy instead of deleting it', async () => {
    const { v, a, b } = await burst('scope-skip')
    a.selective.excludedFolders = ['Burst']
    await a.rescan()
    await a.rm('Burst/x.md')
    const quiet = await a.sync()
    expect(quiet.push.committed).toBeNull()

    a.selective.excludedFolders = []
    const widened = await a.rescan()

    expect(widened.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    expect(await a.text('Burst/x.md')).toBe('x\n')
    await converge(a, b)
    expect(await b.text('Burst/x.md')).toBe('x\n')
  })

  it('the same with no sync between the delete and the widening, on a rebuilt engine', async () => {
    const { v, a, b } = await burst('scope-skip-quick')
    // The host rebuilds the engine on each scope change and its first run is a rescan.
    const narrow = v.rebuild(a, skipping('Burst'))
    await narrow.rescan()
    // A phone: the delete is made and the folder taken back before anything syncs again.
    await narrow.rm('Burst/x.md')
    const wide = v.rebuild(a, selectiveDefaults())
    const widened = await wide.rescan()

    expect(widened.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    expect(await wide.text('Burst/x.md')).toBe('x\n')
    await converge(wide, b)
  })

  it('a raised size cap fetches the big file again instead of deleting it', async () => {
    const v = await vault('scope-cap')
    const a = await v.device('a')
    const b = await v.device('b')
    const big = 'B'.repeat(200)
    await b.write('Big/video.mp4', big)
    await b.write('note.md', 'note\n')
    await b.sync()
    await a.sync()
    expect(await a.text('Big/video.mp4')).toBe(big)

    a.selective.maxFileBytes = 100
    await a.rescan()
    await a.rm('Big/video.mp4')
    expect((await a.sync()).push.committed).toBeNull()

    a.selective.maxFileBytes = null
    const widened = await a.rescan()

    expect(widened.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Big/video.mp4', 'note.md'])
    expect(await a.text('Big/video.mp4')).toBe(big)
    await converge(a, b)
  })

  it('a delete made in scope and caught by a narrowing before it was pushed comes back', async () => {
    const { v, a, b } = await burst('scope-narrow-before-push')
    await a.rm('Burst/x.md')
    // Narrowed before any sync: the engine cannot tell this delete from one made out of scope,
    // so it takes the side that loses nothing — the file stays on the server and comes back.
    a.selective.excludedFolders = ['Burst']
    expect((await a.rescan()).push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])

    a.selective.excludedFolders = []
    expect((await a.rescan()).push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    expect(await a.text('Burst/x.md')).toBe('x\n')
    await converge(a, b)
  })

  it('a delete made after the scope widened again is sent as usual', async () => {
    const { v, a, b } = await burst('scope-delete-after')
    a.selective.excludedFolders = ['Burst']
    await a.rescan()
    a.selective.excludedFolders = []
    await a.rescan()
    await a.rm('Burst/x.md')
    const report = await a.sync()

    expect(report.push.applied).toBe(1)
    expect(await v.paths()).toEqual(['Burst/y.md', 'note.md'])
    await converge(a, b)
    expect(b.has('Burst/x.md')).toBe(false)
  })
})

describe('a file changed elsewhere while out of scope here', () => {
  it('drops an old local copy when a move out of scope is followed by an edit in one feed page', async () => {
    const { a, b } = await burst('scope-move-then-edit')
    a.selective.excludedFolders = ['Archive']
    await a.rescan()
    await b.mv('Burst/x.md', 'Archive/x.md')
    await b.sync()
    await b.write('Archive/x.md', 'edited after the move\n')
    await b.sync()

    await a.sync()
    expect(a.has('Burst/x.md')).toBe(false)
    expect(await a.state.get('Burst/x.md')).toBeNull()
    expect(a.has('Archive/x.md')).toBe(false)
  })

  it('a delete on the server while skipped here takes this device’s unedited copy on widening', async () => {
    const { v, a, b } = await burst('scope-server-delete')
    a.selective.excludedFolders = ['Burst']
    await a.rescan()
    await b.rm('Burst/x.md')
    await b.sync()
    await a.sync()
    // Out of scope, the local copy is left alone.
    expect(await a.text('Burst/x.md')).toBe('x\n')

    a.selective.excludedFolders = []
    const widened = await a.rescan()

    expect(a.has('Burst/x.md')).toBe(false)
    expect(widened.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/y.md', 'note.md'])
    await converge(a, b)
  })

  it('a delete on the server while skipped here loses to an edit made here meanwhile', async () => {
    const { v, a, b } = await burst('scope-server-delete-edited')
    a.selective.excludedFolders = ['Burst']
    await a.rescan()
    await b.rm('Burst/x.md')
    await b.sync()
    await a.write('Burst/x.md', 'x, edited while skipped\n')
    await a.sync()

    a.selective.excludedFolders = []
    await a.rescan()

    expect(await a.text('Burst/x.md')).toBe('x, edited while skipped\n')
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    await converge(a, b)
    expect(await b.text('Burst/x.md')).toBe('x, edited while skipped\n')
  })

  it('narrowed and widened with nothing changed here: the server’s edit arrives, nothing is sent', async () => {
    const { v, a, b } = await burst('scope-roundtrip')
    a.selective.excludedFolders = ['Burst']
    await a.rescan()
    await b.write('Burst/y.md', 'y, edited on b\n')
    await b.sync()
    await a.sync()
    expect(await a.text('Burst/y.md')).toBe('y\n')

    a.selective.excludedFolders = []
    const widened = await a.rescan()

    expect(widened.push.committed).toBeNull()
    expect(await a.text('Burst/y.md')).toBe('y, edited on b\n')
    expect(await a.text('Burst/x.md')).toBe('x\n')
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    await converge(a, b)
  })

  it('the cap lowered and raised with the file still here: nothing lost, nothing sent', async () => {
    const v = await vault('scope-cap-roundtrip')
    const a = await v.device('a', capped(null))
    await a.write('big.bin', 'B'.repeat(200))
    await a.sync()
    a.selective.maxFileBytes = 100
    await a.rescan()
    a.selective.maxFileBytes = null
    const widened = await a.rescan()
    expect(widened.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['big.bin'])
    expect(a.has('big.bin')).toBe(true)
  })
})

/**
 * No run at all between the narrowing and the widening: a paused plugin rebuilds the engine on
 * each scope change and runs nothing, a stopped daemon runs nothing, and a device upgraded from a
 * build that kept no marks has none to read. The marks are taken
 * when an engine is built, before the server is asked anything.
 */
describe('a scope changed with no sync in between', () => {
  it('paused: skipped, emptied and taken back with no run, then resumed', async () => {
    const { v, a, b } = await burst('scope-paused')
    // Skip Burst: the host rebuilds the engine, paused, and runs nothing — nor asks it for
    // anything: building it is all that marks.
    const narrow = v.rebuild(a, skipping('Burst'))
    await narrow.rm('Burst/x.md')
    // Take it back: rebuilt again, still nothing runs. Then resume.
    const wide = v.rebuild(a, selectiveDefaults())
    const resumed = await wide.sync()

    expect(resumed.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    expect(await wide.text('Burst/x.md')).toBe('x\n')
    await converge(wide, b)
  })

  it('an engine built on the narrowed scope marks it without being awaited or started', async () => {
    const { v, a } = await burst('scope-built')
    const narrow = v.rebuild(a, skipping('Burst'))
    // Nothing is asked of the engine; building it is what the host does on the change.
    void narrow
    await new Promise((resolve) => setTimeout(resolve, 20))
    await a.rm('Burst/x.md')
    const wide = v.rebuild(a, selectiveDefaults())
    const resumed = await wide.sync()
    expect(resumed.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
  })

  it('upgraded from a build with no marks: a file missing at the first build comes back', async () => {
    const { v, a, b } = await burst('scope-upgrade')
    // What the older build left: a ledger, and nothing about the scope it last ran on.
    await a.state.setMeta('out-of-scope-files', null)
    await a.state.setMeta('marked-scope', null)
    // Narrowed on the old build, emptied, and widened before the new build ever ran.
    await a.rm('Burst/x.md')
    const upgraded = v.rebuild(a, selectiveDefaults())
    const first = await upgraded.sync()

    expect(first.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
    expect(await upgraded.text('Burst/x.md')).toBe('x\n')
    await converge(upgraded, b)

    // Once, at the upgrade: a delete after it is sent as usual.
    await upgraded.rm('Burst/y.md')
    await upgraded.sync()
    expect(await v.paths()).toEqual(['Burst/x.md', 'note.md'])
  })

  it('the scope the last marks were taken under is kept, and its exclusions marked again', async () => {
    const { v, a } = await burst('scope-previous')
    const narrow = v.rebuild(a, skipping('Burst'))
    await narrow.engine.recordScope()
    expect(JSON.parse((await a.state.getMeta('marked-scope')) ?? 'null')).toMatchObject({
      selective: { excludedFolders: ['Burst'] },
    })
    // Marks lost (a store rolled back, a crash between two writes): the kept scope still says
    // what was out.
    await a.state.setMeta('out-of-scope-files', null)
    await a.rm('Burst/x.md')
    const wide = v.rebuild(a, selectiveDefaults())
    const resumed = await wide.sync()
    expect(resumed.push.committed).toBeNull()
    expect(await v.paths()).toEqual(['Burst/x.md', 'Burst/y.md', 'note.md'])
  })
})
