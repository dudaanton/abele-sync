import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { CommitOp } from '@abele/sync-protocol'
import {
  joinFinished,
  MemoryFileSystem,
  selectiveDefaults,
  type VaultClient,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { create, seed, shaOf } from '../helpers/seed.js'

/**
 * Joining a vault the device already has files for, with each of the
 * three choices: merge both (no `joinPrefer`), this device wins (`mine`), the server wins
 * (`theirs`). One file of every class of the decision's table, on the disk and on the server,
 * then one sync — and for every class the final disk, the server's head, and where the loser
 * went. Nothing the device had is ever written over before the server has answered the commit
 * that stored it.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

type Mode = 'merge' | 'mine' | 'theirs'

/** What happened, in order: commits going out and coming back, and every change to the disk. */
type Event =
  | { kind: 'sent' | 'answered'; creates: CommitOp[] }
  | { kind: 'disk'; what: 'write' | 'move' | 'remove'; paths: string[] }

/** A memory disk that writes each change it is asked for into the shared log first. */
class RecordingFs extends MemoryFileSystem {
  constructor(private readonly events: Event[]) {
    super()
  }
  override async writeAtomic(path: string, bytes: Uint8Array, mtime: number): Promise<void> {
    this.events.push({ kind: 'disk', what: 'write', paths: [path] })
    return super.writeAtomic(path, bytes, mtime)
  }
  override async move(from: string, to: string): Promise<void> {
    this.events.push({ kind: 'disk', what: 'move', paths: [from, to] })
    return super.move(from, to)
  }
  override async remove(path: string): Promise<void> {
    this.events.push({ kind: 'disk', what: 'remove', paths: [path] })
    return super.remove(path)
  }
}

/** The harness's transport, with every commit written into the log as it leaves and returns. */
function recordingFetch(events: Event[], loseFirstAnswer = false): typeof fetch {
  let lost = !loseFirstAnswer
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!new URL(href).pathname.endsWith('/commit')) return h.fetch(input, init)
    const ops = (JSON.parse(String(init?.body)) as { ops: CommitOp[] }).ops
    const creates = ops.filter((op) => op.op === 'create')
    events.push({ kind: 'sent', creates })
    const response = await h.fetch(input, init)
    if (!lost) {
      // The server did the work and filed its answer; the device never hears it.
      lost = true
      throw new TypeError('fetch failed: the connection dropped')
    }
    events.push({ kind: 'answered', creates })
    return response
  }
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Bytes that are an image to the kind table, and distinct per label. */
const png = (label: string): Uint8Array => enc(`\x89PNG ${label}`)

/** Every class of the table, as the server and the joining disk each hold it. */
const SERVER = {
  same: 'same\n',
  note: 'server line\n',
  hereNewer: png('server, older'),
  thereNewer: png('server, newer'),
  settings: '{"theme":"server"}',
  serverOnly: 'only on the server\n',
  trashed: 'deleted on the server\n',
  excluded: 'server secret\n',
  cased: 'server case\n',
}
const LOCAL = {
  same: 'same\n',
  note: 'local line\n',
  hereNewer: png('here, newer'),
  thereNewer: png('here, older'),
  settings: '{"theme":"here"}',
  localOnly: 'only here\n',
  trashed: 'back again\n',
  excluded: 'local secret\n',
  cased: 'local case\n',
}

/** The paths of the classes where both sides hold other bytes: B1, B2 and I. */
const RACED = ['Both.md', 'here-newer.png', 'there-newer.png', '.obsidian/app.json']

interface Joined {
  vaultId: string
  token: string
  joiner: Device
  seeder: VaultClient
  events: Event[]
  ids: Map<string, string>
  trashedId: string
}

/**
 * A vault seeded with the server's side of every class, and a device about to join it with the
 * disk's side. Nothing has synced yet when this returns.
 */
async function setUp(mode: Mode, loseFirstAnswer = false): Promise<Joined> {
  const { vaultId } = await h.vault(account, `join-${mode}-${loseFirstAnswer}`)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const seeded = await seed(seeder, [
    await create(seeder, 'Same.md', SERVER.same, 100),
    await create(seeder, 'Both.md', SERVER.note, 100),
    await create(seeder, 'here-newer.png', SERVER.hereNewer, 100),
    await create(seeder, 'there-newer.png', SERVER.thereNewer, 300),
    await create(seeder, '.obsidian/app.json', SERVER.settings, 100),
    await create(seeder, 'Server only.md', SERVER.serverOnly, 100),
    await create(seeder, 'Gone.md', SERVER.trashed, 100),
    await create(seeder, 'Private/secret.md', SERVER.excluded, 100),
    await create(seeder, 'Case.md', SERVER.cased, 100),
  ])
  const ids = new Map<string, string>()
  for (const result of seeded.results) {
    if (result.status !== 'rejected') ids.set(result.path, result.file_id)
  }
  const gone = seeded.results[6]
  if (gone === undefined || gone.status === 'rejected') throw new Error('Gone.md not seeded')
  await seed(seeder, [{ op: 'delete', file_id: gone.file_id, base_version_id: gone.version_id }])

  const events: Event[] = []
  const { deviceToken } = await h.device(account, vaultId, 'joiner')
  const selective = selectiveDefaults()
  selective.excludedFolders = ['Private']
  const joiner = new Device(h, vaultId, deviceToken, 'joiner', {
    fs: new RecordingFs(events),
    selective,
    fetch: recordingFetch(events, loseFirstAnswer),
    ...(mode === 'merge' ? {} : { joinPrefer: mode }),
  })
  await joiner.write('Same.md', LOCAL.same, 50)
  await joiner.write('Both.md', LOCAL.note, 200)
  await joiner.write('here-newer.png', LOCAL.hereNewer, 200)
  await joiner.write('there-newer.png', LOCAL.thereNewer, 50)
  await joiner.write('.obsidian/app.json', LOCAL.settings, 200)
  await joiner.write('Local only.md', LOCAL.localOnly, 50)
  await joiner.write('Gone.md', LOCAL.trashed, 50)
  await joiner.write('Private/secret.md', LOCAL.excluded, 50)
  await joiner.write('case.md', LOCAL.cased, 50)
  // The setup's own writes are not the engine's.
  events.length = 0
  return { vaultId, token: deviceToken, joiner, seeder, events, ids, trashedId: gone.file_id }
}

/** The server's live files, path → bytes as text (latin1, so an image reads too). */
async function serverHeads(client: VaultClient): Promise<Map<string, string>> {
  const heads = new Map<string, string>()
  let cursor: string | null = null
  do {
    const page = await client.manifest(cursor)
    for (const item of page.items) {
      if (item.sha === null) continue
      heads.set(item.path, Buffer.from(await client.getBlob(item.sha)).toString('latin1'))
    }
    cursor = page.next
  } while (cursor !== null)
  return heads
}

const text = (bytes: string | Uint8Array): string =>
  typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('latin1')

/** Every sha a file's history holds. */
const shasOf = async (client: VaultClient, fileId: string): Promise<string[]> =>
  (await client.versions(fileId)).flatMap((v) => (v.sha === null ? [] : [v.sha]))

/**
 * The ordering the join promises: every change to a raced path's disk comes after the answer
 * to the commit whose create carried that path's local bytes — with the local sha in it, so
 * the answer is to the commit that stored them, not to some other batch.
 */
function assertWrittenOnlyAfterAnswered(events: Event[], localShas: Map<string, string>): void {
  for (const path of RACED) {
    const answered = events.findIndex(
      (e) =>
        e.kind === 'answered' &&
        e.creates.some(
          (op) => op.op === 'create' && op.path === path && op.sha === localShas.get(path)
        )
    )
    expect(answered, `${path}: its create was never answered`).toBeGreaterThanOrEqual(0)
    const touched = events.findIndex((e) => e.kind === 'disk' && e.paths.includes(path))
    if (touched !== -1) {
      expect(touched, `${path} was changed on disk before its commit answered`).toBeGreaterThan(
        answered
      )
    }
  }
}

/** What each mode should leave where both sides had a file: the side whose bytes are the head. */
const WINNER: Record<Mode, Record<string, 'server' | 'local'>> = {
  merge: {
    'here-newer.png': 'local',
    'there-newer.png': 'server',
    '.obsidian/app.json': 'local',
  },
  mine: { 'here-newer.png': 'local', 'there-newer.png': 'local', '.obsidian/app.json': 'local' },
  theirs: {
    'here-newer.png': 'server',
    'there-newer.png': 'server',
    '.obsidian/app.json': 'server',
  },
}
const SIDES: Record<string, { server: string | Uint8Array; local: string | Uint8Array }> = {
  'here-newer.png': { server: SERVER.hereNewer, local: LOCAL.hereNewer },
  'there-newer.png': { server: SERVER.thereNewer, local: LOCAL.thereNewer },
  '.obsidian/app.json': { server: SERVER.settings, local: LOCAL.settings },
}
const NOTE: Record<Mode, string> = {
  merge: 'server line\nlocal line\n',
  mine: LOCAL.note,
  theirs: SERVER.note,
}

async function localShas(): Promise<Map<string, string>> {
  return new Map([
    ['Both.md', await shaOf(LOCAL.note)],
    ['here-newer.png', await shaOf(LOCAL.hereNewer)],
    ['there-newer.png', await shaOf(LOCAL.thereNewer)],
    ['.obsidian/app.json', await shaOf(LOCAL.settings)],
  ])
}

async function assertJoined(mode: Mode, j: Joined): Promise<void> {
  const { joiner, seeder, ids } = j
  const heads = await serverHeads(seeder)

  // A. Same bytes: adopted, the same file on both sides.
  expect(await joiner.text('Same.md')).toBe(LOCAL.same)
  expect((await joiner.state.get('Same.md'))?.fileId).toBe(ids.get('Same.md'))
  expect(await shasOf(seeder, ids.get('Same.md') ?? '')).toEqual([await shaOf(SERVER.same)])

  // B1. A note on both sides.
  expect(await joiner.text('Both.md')).toBe(NOTE[mode])
  expect(heads.get('Both.md')).toBe(NOTE[mode])
  const noteHistory = await shasOf(seeder, ids.get('Both.md') ?? '')
  expect(noteHistory).toContain(await shaOf(SERVER.note))
  if (mode !== 'merge') expect(noteHistory).toContain(await shaOf(LOCAL.note))

  // B2 and I. Other files on both sides: the winner is the head everywhere, the loser a version.
  for (const [path, winner] of Object.entries(WINNER[mode])) {
    const sides = SIDES[path]
    if (sides === undefined) throw new Error(path)
    const won = text(sides[winner])
    const lost = sides[winner === 'server' ? 'local' : 'server']
    expect(text((await joiner.bytes(path)) ?? ''), `${mode}: ${path} on disk`).toBe(won)
    expect(heads.get(path), `${mode}: ${path} on the server`).toBe(won)
    expect(await shasOf(seeder, ids.get(path) ?? ''), `${mode}: ${path}'s loser`).toContain(
      await shaOf(lost)
    )
  }

  // C and D. One side only: uploaded, downloaded.
  expect(heads.get('Local only.md')).toBe(LOCAL.localOnly)
  expect(await joiner.text('Server only.md')).toBe(SERVER.serverOnly)

  // E. In the server's trash, here on the disk: a new file, and the old one still restorable.
  expect(await joiner.text('Gone.md')).toBe(LOCAL.trashed)
  expect(heads.get('Gone.md')).toBe(LOCAL.trashed)
  expect((await joiner.state.get('Gone.md'))?.fileId).not.toBe(j.trashedId)
  expect((await seeder.trash()).map((item) => item.file_id)).toContain(j.trashedId)

  // G. Excluded here: untouched on both sides.
  expect(await joiner.text('Private/secret.md')).toBe(LOCAL.excluded)
  expect(heads.get('Private/secret.md')).toBe(SERVER.excluded)
  expect(await shasOf(seeder, ids.get('Private/secret.md') ?? '')).toEqual([
    await shaOf(SERVER.excluded),
  ])

  // H. A fresh file named like a synced one but for case, on a case-sensitive disk: held.
  expect(await joiner.text('case.md')).toBe(LOCAL.cased)
  expect(await joiner.text('Case.md')).toBe(SERVER.cased)
  expect(heads.get('Case.md')).toBe(SERVER.cased)
  expect(heads.has('case.md')).toBe(false)

  // Nothing else appeared: no conflict copies, nothing the table does not name.
  expect([...heads.keys()].sort()).toEqual([
    '.obsidian/app.json',
    'Both.md',
    'Case.md',
    'Gone.md',
    'Local only.md',
    'Private/secret.md',
    'Same.md',
    'Server only.md',
    'here-newer.png',
    'there-newer.png',
  ])
  await joiner.assertStateMatchesDisk()
}

describe('joining a vault that already has files', () => {
  for (const mode of ['merge', 'mine', 'theirs'] as const) {
    it(`${mode}: every class ends as the table says, in one sync, and every loser is a version`, async () => {
      const j = await setUp(mode)
      const report = await j.joiner.sync()

      expect(report.pull.bootstrapped).toBe(true)
      expect((report.secondPull ?? report.pull).held).toEqual([])
      expect(await j.joiner.cursor()).toBeGreaterThan(0)
      expect(j.joiner.rejected).toEqual([])
      // Every create carries the choice, and only a choice that was made.
      const sent = j.events.flatMap((e) => (e.kind === 'sent' ? e.creates : []))
      expect(sent.length).toBeGreaterThan(0)
      for (const op of sent) {
        if (op.op !== 'create') continue
        if (mode === 'merge') expect(op).not.toHaveProperty('prefer')
        else expect(op.prefer).toBe(mode)
      }

      await assertJoined(mode, j)
      assertWrittenOnlyAfterAnswered(j.events, await localShas())

      // A second sync has nothing left to do.
      const again = await j.joiner.sync()
      expect(again.push.committed).toBeNull()
      expect(again.pull.applied).toBe(0)
      await assertJoined(mode, j)
    })
  }

  it('theirs, with the commit answer lost: nothing here is written over until the replay has it', async () => {
    const j = await setUp('theirs', true)
    await expect(j.joiner.sync()).rejects.toThrow()

    // The server applied the batch, but the device never heard: every raced file is as it was.
    expect(await j.joiner.text('Both.md')).toBe(LOCAL.note)
    for (const path of Object.keys(SIDES)) {
      expect(text((await j.joiner.bytes(path)) ?? '')).toBe(text(SIDES[path]?.local ?? ''))
    }
    const journal = await j.joiner.state.getJournal()
    const journalled = (journal?.ops ?? []).filter((op) => op.op === 'create')
    expect(journalled.length).toBeGreaterThan(0)
    for (const op of journalled) expect(op).toMatchObject({ prefer: 'theirs' })

    const report = await j.joiner.sync()
    expect(report.push.replayed).toBe(true)
    await assertJoined('theirs', j)
    assertWrittenOnlyAfterAnswered(j.events, await localShas())
  })
})

describe('the preference is for the join and nothing after it', () => {
  /** A joined device, and a note the seeder adds that the joiner also writes on its own. */
  async function joinedThenRaced(): Promise<Joined> {
    const j = await setUp('theirs')
    const report = await j.joiner.sync()
    expect(joinFinished(report)).toBe(true)
    await seed(j.seeder, [await create(j.seeder, 'Late.md', 'server late\n', 100)])
    await j.joiner.write('Late.md', 'local late\n', 200)
    j.events.length = 0
    return j
  }

  const sentCreates = (events: Event[]): CommitOp[] =>
    events.flatMap((e) => (e.kind === 'sent' ? e.creates : []))

  it('a rescan by the engine that joined sends no preference: the note is merged', async () => {
    const j = await joinedThenRaced()
    await j.joiner.rescan()
    expect(sentCreates(j.events)).toEqual([expect.objectContaining({ path: 'Late.md' })])
    expect(sentCreates(j.events)[0]).not.toHaveProperty('prefer')
    expect(await j.joiner.text('Late.md')).toBe('server late\nlocal late\n')
  })

  it('nor does a fresh engine given the same choice, once the cursor is above 0', async () => {
    const j = await joinedThenRaced()
    const again = new Device(h, j.vaultId, j.token, 'joiner', {
      fs: j.joiner.fs,
      state: j.joiner.state,
      selective: j.joiner.selective,
      fetch: recordingFetch(j.events),
      joinPrefer: 'theirs',
    })
    await again.rescan()
    expect(sentCreates(j.events)).toEqual([expect.objectContaining({ path: 'Late.md' })])
    expect(sentCreates(j.events)[0]).not.toHaveProperty('prefer')
    expect(await again.text('Late.md')).toBe('server late\nlocal late\n')
  })

  it('joinFinished: the sync that was joining and got its push answered, whatever it still holds', () => {
    const pull = { applied: 0, held: [], skipped: 0, cursor: 5, bootstrapped: true, deferred: 0 }
    const push = {
      committed: null,
      applied: 0,
      merged: 0,
      conflicts: 0,
      rejected: [],
      replayed: false,
      kept: [],
    }
    const base = { pull, push, secondPull: null, collisions: [], deferred: 0, joined: true }
    expect(joinFinished(base)).toBe(true)
    // Whether the pull walked the manifest says nothing: a rescan walks it too.
    expect(joinFinished({ ...base, joined: false })).toBe(false)
    // A join that held something leaves the cursor at 0; its creates were answered all the same.
    const held = { ...pull, cursor: 0, held: [{} as never] }
    expect(joinFinished({ ...base, pull: held })).toBe(true)
  })
})
