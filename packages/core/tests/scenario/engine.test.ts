import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  EngineError,
  IgnoreRules,
  MemoryFileSystem,
  selectiveDefaults,
  type VaultClient,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge, type DeviceOptions } from '../helpers/device.js'
import { create, seed, shaOf } from '../helpers/seed.js'

/**
 * What the engine adds to the simulated tier: a process that dies with a commit in the air,
 * and the files a device chooses not to sync — by type, by settings category, by ignore rule.
 */

let h: Harness, account: string

interface Vault {
  vaultId: string
  /** A client of the scenario's own, for seeding and for reading what the server holds. */
  observer: VaultClient
  device(name: string, opts?: DeviceOptions): Promise<Device>
  /** The same device in a fresh process: its token, its disk and its state, and nothing in memory. */
  revive(device: Device): Device
  /** Every live path the server lists, in path order. */
  paths(): Promise<string[]>
}

async function vault(name: string): Promise<Vault> {
  const { vaultId } = await h.vault(account, name)
  const observer = h.clientFor((await h.device(account, vaultId, 'observer')).deviceToken, vaultId)
  return {
    vaultId,
    observer,
    device: async (device, opts) => {
      const { deviceToken } = await h.device(account, vaultId, device)
      return new Device(h, vaultId, deviceToken, device, opts)
    },
    revive: (device) =>
      new Device(h, vaultId, device.deviceToken, device.name, {
        selective: device.selective,
        fs: device.fs,
        state: device.state,
      }),
    paths: async () => (await observer.manifest(null)).items.map((item) => item.path),
  }
}

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

describe('a crash in the middle of a push', () => {
  it('replays the journal on the next sync: one version, the file synced, the journal cleared', async () => {
    const v = await vault('crash')
    const d = await v.device('laptop')
    // The server applies the commit; the answer never makes it back into the state.
    const commitRaw = d.client.commitRaw.bind(d.client)
    let crash = true
    d.client.commitRaw = async (ops, key) => {
      const outcome = await commitRaw(ops, key)
      if (!crash) return outcome
      crash = false
      throw new EngineError('io', 'the process died')
    }
    await d.write('note.md', 'written before the crash\n')

    await expect(d.sync()).rejects.toThrow('the process died')

    expect(d.stats.commits).toBe(1)
    expect(await v.paths()).toEqual(['note.md'])
    // The journal is what survives: the ops, and the key the server filed its answer under.
    const journal = await d.state.getJournal()
    expect(journal?.ops.map((op) => op.op)).toEqual(['create'])
    expect(await d.state.get('note.md')).toBeNull()
    expect(d.engine.status).toMatchObject({ state: 'error', lastError: 'the process died' })

    // A fresh process over the same disk and the same state: nothing in memory carries over.
    const again = v.revive(d)
    const report = await again.sync()

    // The batch went up again under its key; the server answered from its file, not the vault.
    expect(report.push).toMatchObject({ replayed: true, applied: 1, rejected: [] })
    expect(again.stats).toEqual({ blobPuts: 0, blobHeads: 1, blobGets: 0, commits: 1 })
    expect(await again.state.getJournal()).toBeNull()
    const entry = await again.state.get('note.md')
    expect(entry).toMatchObject({ sha: await shaOf('written before the crash\n') })
    expect(await v.observer.versions(entry?.fileId ?? '')).toHaveLength(1)
    expect((await v.observer.state()).head_seq).toBe(1)
    expect(await v.paths()).toEqual(['note.md'])
    // Level: nothing more to send.
    expect((await again.sync()).push.committed).toBeNull()
    expect(again.engine.status).toMatchObject({ state: 'idle', pending: 0, lastError: null })
  })

  it('replays a journal whose commit never reached the server, applying the batch once', async () => {
    const v = await vault('crash-before')
    const d = await v.device('laptop')
    const commitRaw = d.client.commitRaw.bind(d.client)
    let crash = true
    d.client.commitRaw = async (ops, key) => {
      if (!crash) return commitRaw(ops, key)
      crash = false
      throw new EngineError('offline', 'the line went dead')
    }
    await d.write('note.md', 'never arrived\n')

    await expect(d.sync()).rejects.toThrow('the line went dead')
    expect(await v.paths()).toEqual([])
    expect(await d.state.getJournal()).not.toBeNull()

    const again = v.revive(d)
    const report = await again.sync()

    expect(report.push).toMatchObject({ replayed: false, applied: 1 })
    expect(await v.paths()).toEqual(['note.md'])
    expect(await again.state.getJournal()).toBeNull()
    expect((await v.observer.state()).head_seq).toBe(1)
  })
})

describe('selective sync', () => {
  it('a device with video off neither uploads its own clip nor downloads another device’s', async () => {
    const v = await vault('selective-video')
    const a = await v.device('a', { selective: { ...selectiveDefaults(), video: false } })
    const b = await v.device('b')
    await a.write('notes/x.md', 'a note\n')
    await a.write('clip.mp4', 'a local clip')
    await a.sync()

    expect(await v.paths()).toEqual(['notes/x.md'])
    expect(a.stats).toEqual({ blobPuts: 1, blobHeads: 1, blobGets: 0, commits: 1 })

    await b.sync()
    await b.write('remote.mp4', 'a clip from b')
    await b.sync()
    expect(await v.paths()).toEqual(['notes/x.md', 'remote.mp4'])

    await a.sync()
    expect(a.paths()).toEqual(['clip.mp4', 'notes/x.md'])
    expect(a.stats.blobGets).toBe(0)
    expect(await a.state.get('remote.mp4')).toBeNull()
    // Level, as far as this device is concerned: the clip passed over, nothing held.
    expect(a.engine.status.cursor).toBe((await v.observer.state()).head_seq)
  })

  it('turning video on brings the remote clip down and the local one up', async () => {
    const v = await vault('selective-toggle')
    const a = await v.device('a', { selective: { ...selectiveDefaults(), video: false } })
    const b = await v.device('b')
    await a.write('clip.mp4', 'a local clip')
    await b.write('remote.mp4', 'a clip from b')
    await b.sync()
    await a.sync()
    expect(a.has('remote.mp4')).toBe(false)
    expect(await v.paths()).toEqual(['remote.mp4'])

    a.selective.video = true
    // Widened, the host asks for a rescan: the manifest is walked again and finds what the
    // pulls passed over. Everything the device already has is known by its version.
    const report = await a.rescan()

    expect(report.pull).toMatchObject({ bootstrapped: true, applied: 1 })
    expect(await a.text('remote.mp4')).toBe('a clip from b')
    expect(report.push).toMatchObject({ applied: 1 })
    expect(await v.paths()).toEqual(['clip.mp4', 'remote.mp4'])
    await converge(a, b)
    expect(b.paths()).toEqual(['clip.mp4', 'remote.mp4'])
  })

  it('a synced file that becomes excluded stays on the disk and in the vault', async () => {
    const v = await vault('selective-excluded')
    const a = await v.device('a')
    const b = await v.device('b')
    await a.write('pic.png', 'a picture')
    await a.write('note.md', 'a note\n')
    await a.sync()
    await b.sync()
    expect(b.paths()).toEqual(['note.md', 'pic.png'])

    a.selective.images = false
    const report = await a.sync()

    // Nothing to send: an entry this device no longer syncs is not a delete.
    expect(report.push.committed).toBeNull()
    expect(a.has('pic.png')).toBe(true)
    expect(await v.paths()).toEqual(['note.md', 'pic.png'])

    // Changes to it from elsewhere pass this device by, and its copy stays what it was.
    await b.write('pic.png', 'a new picture')
    await b.sync()
    await a.sync()
    expect(await a.text('pic.png')).toBe('a picture')
    expect(await b.text('pic.png')).toBe('a new picture')
    expect(await v.paths()).toEqual(['note.md', 'pic.png'])
    // The note still flows both ways.
    await a.write('note.md', 'a note, edited\n')
    await a.sync()
    await b.sync()
    expect(await b.text('note.md')).toBe('a note, edited\n')
  })
})

describe('settings sync', () => {
  it('app.json round-trips, workspace.json never moves, and a plugin’s data.json only with pluginSettings', async () => {
    const v = await vault('settings')
    const a = await v.device('a')
    const b = await v.device('b', {
      selective: {
        ...selectiveDefaults(),
        settings: { ...selectiveDefaults().settings, pluginSettings: false },
      },
    })
    await a.write('.obsidian/app.json', '{"a":1}')
    await a.write('.obsidian/workspace.json', '{"layout":"here"}')
    await a.write('.obsidian/plugins/x/data.json', '{"x":true}')
    await a.write('note.md', 'a note\n')
    await a.sync()

    expect(await v.paths()).toEqual([
      '.obsidian/app.json',
      '.obsidian/plugins/x/data.json',
      'note.md',
    ])

    await b.sync()
    expect(b.paths()).toEqual(['.obsidian/app.json', 'note.md'])
    expect(await b.text('.obsidian/app.json')).toBe('{"a":1}')

    // A workspace somebody committed regardless comes down on nobody.
    await seed(v.observer, [
      await create(v.observer, '.obsidian/workspace.json', '{"layout":"theirs"}'),
    ])
    await a.sync()
    await b.sync()
    expect(await a.text('.obsidian/workspace.json')).toBe('{"layout":"here"}')
    expect(b.has('.obsidian/workspace.json')).toBe(false)

    // An edit to app.json on b goes back to a.
    await b.write('.obsidian/app.json', '{"a":2}')
    await b.sync()
    await a.sync()
    expect(await a.text('.obsidian/app.json')).toBe('{"a":2}')

    // Switched on, the plugin's settings arrive.
    b.selective.settings.pluginSettings = true
    await b.rescan()
    expect(await b.text('.obsidian/plugins/x/data.json')).toBe('{"x":true}')
    expect(b.has('.obsidian/workspace.json')).toBe(false)
  })
})

describe('the ignore file', () => {
  it('a path the rules ignore is neither uploaded nor downloaded', async () => {
    const v = await vault('ignore')
    const a = await v.device('a', { ignore: IgnoreRules.parse('*.tmp\n') })
    const b = await v.device('b')
    await a.write('note.md', 'a note\n')
    await a.write('scratch.tmp', 'scratch')
    await a.sync()
    expect(await v.paths()).toEqual(['note.md'])
    expect(a.stats.blobPuts).toBe(1)

    await b.write('theirs.tmp', 'theirs')
    await b.sync()
    expect(await v.paths()).toEqual(['note.md', 'theirs.tmp'])

    await a.sync()
    expect(a.paths()).toEqual(['note.md', 'scratch.tmp'])
    expect(a.stats.blobGets).toBe(0)
    expect(await b.text('note.md')).toBe('a note\n')
  })
})

describe('a case-insensitive disk', () => {
  it('a case-only rename is a rename everywhere, never a delete', async () => {
    const v = await vault('respell')
    const disk = (): MemoryFileSystem => new MemoryFileSystem({ caseInsensitive: true })
    const a = await v.device('a', { fs: disk() })
    const b = await v.device('b', { fs: disk() })
    await a.write('CaseTest.md', 'keep me\n')
    await converge(a, b)

    await a.mv('CaseTest.md', 'casetest.md')
    await converge(a, b)

    expect(await v.paths()).toEqual(['casetest.md'])
    for (const device of [a, b]) {
      expect(device.paths()).toEqual(['casetest.md'])
      expect(await device.text('casetest.md')).toBe('keep me\n')
    }
    const history = (await v.observer.changes(0)).items.map((item) => item.op)
    expect(history).toEqual(['create', 'move'])
  })
})

describe('a case-sensitive disk', () => {
  /**
   * `Image.png` synced, then a stranger `image.png` beside it: the wire and the server hold
   * one of the two. Before the scanner held it back, every sync sent it as a create, and
   * every one of those wrote the loser and the head into history again.
   */
  it('holds a fresh twin of a synced name back, for good, and writes nothing to the vault', async () => {
    const v = await vault('twins')
    const a = await v.device('a')
    await a.write('Image.png', new Uint8Array([1, 2, 3]))
    await a.write('Note.md', 'the synced note\n')
    await a.sync()
    const before = (await v.observer.changes(0)).items.length

    await a.write('image.png', new Uint8Array([9, 9]), 1)
    await a.write('note.md', 'a stranger\n', 1)
    const reports = []
    for (let round = 0; round < 6; round++) reports.push(await a.sync())

    expect((await v.observer.changes(0)).items).toHaveLength(before)
    expect(await v.paths()).toEqual(['Image.png', 'Note.md'])
    for (const report of reports) {
      expect(report.collisions).toEqual([
        { path: 'image.png', wirePath: 'image.png', with: 'Image.png' },
        { path: 'note.md', wirePath: 'note.md', with: 'Note.md' },
      ])
      expect(report.push.committed).toBeNull()
    }
    // Both spellings stay on the disk, untouched, and the log says so once, not every sync.
    expect(a.paths()).toEqual(['Image.png', 'Note.md', 'image.png', 'note.md'])
    expect(await a.text('note.md')).toBe('a stranger\n')
    expect(a.lines.filter((line) => line.includes('image.png'))).toHaveLength(1)

    // Renamed apart, the stranger syncs as a file of its own.
    await a.mv('image.png', 'image 2.png')
    const report = await a.sync()
    expect(report.collisions).toEqual([{ path: 'note.md', wirePath: 'note.md', with: 'Note.md' }])
    expect(await v.paths()).toEqual(['Image.png', 'Note.md', 'image 2.png'])
  })
})

/** For a host to count "Syncing (N)" down while a push is under way (three-node report, B7). */
describe('pending while the push runs', () => {
  it('counts down as each file’s bytes reach the server, and ends at nothing', async () => {
    const v = await vault('pending-countdown')
    const a = await v.device('a')
    await a.write('one.md', 'one\n')
    await a.write('two.md', 'two\n')
    await a.write('three.md', 'three\n')
    const seen: number[] = []
    a.engine.onStatus((status) => seen.push(status.pending))
    await a.sync()
    // From the scan's count, down one file at a time, to nothing.
    const from = seen.indexOf(3)
    expect(from).toBeGreaterThanOrEqual(0)
    const counts = seen.slice(from)
    expect(counts).toContain(2)
    expect(counts).toContain(1)
    expect(counts.at(-1)).toBe(0)
    for (let at = 1; at < counts.length; at++) {
      expect(counts[at]).toBeLessThanOrEqual(counts[at - 1] ?? Infinity)
    }
  })
})
