import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  fileDeleteDecision,
  selectiveDefaults,
  type StateStore,
  type VaultClient,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { blob, create, seed } from '../helpers/seed.js'

/**
 * The mass-delete guard: a sync that would delete many files at once
 * sends everything but those deletes, keeps the files' paths clear of the pulls, and waits for
 * a decision — to send them after all, or to bring the files back from the server.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

const name = (k: number): string => `notes/n${String(k).padStart(3, '0')}.md`

interface Pair {
  seeder: VaultClient
  vaultId: string
  d: Device
}

/** A vault of `n` notes, synced down to a device. */
async function vaultOf(
  label: string,
  n: number,
  opts: { excluded?: string[] } = {}
): Promise<Pair> {
  const { vaultId } = await h.vault(account, label)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const ops = []
  for (let k = 0; k < n; k++) ops.push(await create(seeder, name(k), `note ${k}\n`))
  await seed(seeder, ops)
  const { deviceToken } = await h.device(account, vaultId, 'laptop')
  const d = new Device(h, vaultId, deviceToken, 'laptop', {
    selective: { ...selectiveDefaults(), excludedFolders: opts.excluded ?? [] },
  })
  await d.sync()
  expect(d.paths()).toHaveLength(n)
  return { seeder, vaultId, d }
}

async function trashCount(client: VaultClient): Promise<number> {
  return (await client.trash()).length
}

async function livePaths(client: VaultClient): Promise<string[]> {
  return (await client.manifest(null)).items.map((item) => item.path)
}

describe('a sync that would delete many files', () => {
  it('holds only the deletes, sends the rest, and says so', async () => {
    const { seeder, d } = await vaultOf('guard-trip', 100)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.write('fresh.md', 'new here\n')
    await d.write(name(99), 'note 99, edited\n')
    await d.sync()

    expect(await trashCount(seeder)).toBe(0)
    const live = await livePaths(seeder)
    expect(live).toContain('fresh.md')
    expect(live).toHaveLength(101)
    expect(d.engine.status.heldDeletes).toBe(60)
    const held = await d.engine.heldDeletes()
    expect(held).toHaveLength(60)
    expect(held.map((one) => one.path)).toContain(name(0))
    expect(d.lines.join('\n')).toMatch(/push: held 60 deletions \(60% of the vault\)/)
    // Nothing is pending but the held deletes, and the next sync holds them again.
    expect(d.engine.status.pending).toBe(0)
    const again = await d.sync()
    expect(again.push.committed).toBeNull()
    expect(d.engine.status.heldDeletes).toBe(60)
  })

  it("keeps a held file's path clear of the pull, even when another device edits it", async () => {
    const { seeder, vaultId, d } = await vaultOf('guard-protect', 40)
    for (let k = 0; k < 20; k++) await d.rm(name(k))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(20)

    const item = (await seeder.manifest(null)).items.find((it) => it.path === name(3))
    if (item === undefined) throw new Error('no n003 on the server')
    await seed(seeder, [
      {
        op: 'modify',
        file_id: item.file_id,
        base_version_id: item.version_id,
        ...(await blob(seeder, 'edited elsewhere\n')),
        mtime: 5,
      },
    ])
    const report = await d.sync()
    expect(d.has(name(3))).toBe(false)
    expect(report.pull.held).not.toHaveLength(0)
    expect(d.engine.status.heldDeletes).toBe(20)
    // A fresh process over the same disk and state still keeps them clear.
    const fresh = new Device(h, vaultId, d.deviceToken, 'laptop', { fs: d.fs, state: d.state })
    await fresh.sync()
    expect(fresh.has(name(3))).toBe(false)
    expect(fresh.engine.status.heldDeletes).toBe(20)
  })

  it('counts a move into a folder this device does not sync as a delete', async () => {
    const { seeder, d } = await vaultOf('guard-excluded', 30, { excluded: ['Private'] })
    for (let k = 0; k < 12; k++) await d.mv(name(k), `Private/n${k}.md`)
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(12)
    expect(await trashCount(seeder)).toBe(0)
  })

  it('sends a few deletes and a mass move as they are', async () => {
    const { seeder, d } = await vaultOf('guard-few', 100)
    for (let k = 0; k < 5; k++) await d.rm(name(k))
    for (let k = 10; k < 70; k++) await d.mv(name(k), `moved/n${k}.md`)
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(0)
    expect(await trashCount(seeder)).toBe(5)
    expect((await livePaths(seeder)).filter((path) => path.startsWith('moved/'))).toHaveLength(60)
  })
})

describe('deciding about held deletes', () => {
  it('confirm sends exactly those, and later deletes are judged afresh', async () => {
    const { seeder, d } = await vaultOf('guard-confirm', 100)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(60)

    await d.engine.decideDeletes(
      'confirm',
      (await d.engine.heldDeletes()).map((one) => one.fileId)
    )
    expect(await trashCount(seeder)).toBe(60)
    expect(d.engine.status.heldDeletes).toBe(0)
    expect(await d.engine.heldDeletes()).toEqual([])

    // 15 of the 40 left is more than a quarter of them: held again.
    for (let k = 60; k < 75; k++) await d.rm(name(k))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(15)
    expect(await trashCount(seeder)).toBe(60)
  })

  it('restore brings the files back from the live server copies', async () => {
    const { seeder, d } = await vaultOf('guard-restore', 100)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.sync()

    await d.engine.decideDeletes(
      'restore',
      (await d.engine.heldDeletes()).map((one) => one.fileId)
    )
    expect(d.paths()).toHaveLength(100)
    expect(await d.text(name(7))).toBe('note 7\n')
    expect(d.engine.status.heldDeletes).toBe(0)
    expect(await trashCount(seeder)).toBe(0)
    await d.assertStateMatchesDisk()
    const again = await d.sync()
    expect(again.push.committed).toBeNull()
  })

  it('takes a decision another handle on the state filed, as the command line does', async () => {
    const { seeder, d } = await vaultOf('guard-handle', 100)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.sync()
    const held = await d.engine.heldDeletes()

    // Another object over the same store, as the daemon's CLI opens its own database handle.
    const other: StateStore = Object.create(d.state) as StateStore
    await fileDeleteDecision(other, {
      kind: 'confirm',
      fileIds: held.map((one) => one.fileId),
      at: new Date().toISOString(),
    })
    await d.sync()
    expect(await trashCount(seeder)).toBe(60)
    expect(d.engine.status.heldDeletes).toBe(0)
  })

  it('never holds a journal replay, however many deletes it carries', async () => {
    const { seeder, d } = await vaultOf('guard-journal', 100)
    const items = (await seeder.manifest(null)).items.filter((item) => item.path < name(60))
    expect(items).toHaveLength(60)
    for (const item of items) await d.rm(item.path)
    // A batch the last run wrote down and never saw answered: already the server's to take.
    await d.state.setJournal({
      batchId: 'b-replay',
      idempotencyKey: 'k-replay',
      startedAt: new Date().toISOString(),
      ops: items.map((item) => ({
        op: 'delete',
        file_id: item.file_id,
        base_version_id: item.version_id,
      })),
    })
    await d.sync()
    expect(await trashCount(seeder)).toBe(60)
    expect(d.engine.status.heldDeletes).toBe(0)
  })
})

describe('a hold waits for its decision', () => {
  it('keeps what it held when some files come back, rather than send the rest', async () => {
    const { seeder, d } = await vaultOf('guard-sticky', 100)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(60)
    for (let k = 0; k < 51; k++) await d.write(name(k), `note ${k}\n`)
    await d.sync()
    expect(await trashCount(seeder)).toBe(0)
    expect(d.engine.status.heldDeletes).toBe(9)
  })

  it('counts deletes that trickle in a few a sync, until a decision', async () => {
    const { seeder, d } = await vaultOf('guard-trickle', 100)
    let k = 0
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await d.rm(name(k++))
      await d.sync()
      expect(d.engine.status.heldDeletes).toBe(0)
    }
    expect(await trashCount(seeder)).toBe(24)
    // 32 of the 100 there were a moment ago: a quarter, and held.
    for (let i = 0; i < 8; i++) await d.rm(name(k++))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(8)
    expect(await trashCount(seeder)).toBe(24)

    // A decision starts the count again: the next few go as they come.
    await d.engine.decideDeletes(
      'confirm',
      (await d.engine.heldDeletes()).map((one) => one.fileId)
    )
    expect(await trashCount(seeder)).toBe(32)
    for (let i = 0; i < 8; i++) await d.rm(name(k++))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(0)
    expect(await trashCount(seeder)).toBe(40)
  })

  it('forgets deletes sent longer ago than the window', async () => {
    let now = 1_800_000_000_000
    const { vaultId } = await h.vault(account, 'guard-window')
    const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
    const seeder = h.clientFor(seederToken, vaultId)
    const ops = []
    for (let k = 0; k < 100; k++) ops.push(await create(seeder, name(k), `note ${k}\n`))
    await seed(seeder, ops)
    const { deviceToken } = await h.device(account, vaultId, 'laptop')
    const d = new Device(h, vaultId, deviceToken, 'laptop', { now: () => now })
    await d.sync()
    let k = 0
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 8; i++) await d.rm(name(k++))
      await d.sync()
      expect(d.engine.status.heldDeletes).toBe(0)
      now += 20 * 60 * 1000
    }
    expect(await trashCount(seeder)).toBe(48)
  })

  it('decides only about the deletes the person was shown', async () => {
    const { seeder, d } = await vaultOf('guard-shown', 200)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.sync()
    const shown = (await d.engine.heldDeletes()).map((one) => one.fileId)
    expect(shown).toHaveLength(60)
    for (let k = 60; k < 160; k++) await d.rm(name(k))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(160)

    await d.engine.decideDeletes('confirm', shown)
    expect(await trashCount(seeder)).toBe(60)
    expect(d.engine.status.heldDeletes).toBe(100)
  })

  it('restores only the files named, and keeps the rest held', async () => {
    const { seeder, d } = await vaultOf('guard-restore-some', 100)
    for (let k = 0; k < 60; k++) await d.rm(name(k))
    await d.sync()
    const held = await d.engine.heldDeletes()
    const some = held.filter((one) => one.path < name(10)).map((one) => one.fileId)
    expect(some).toHaveLength(10)

    await d.engine.decideDeletes('restore', some)
    for (let k = 0; k < 10; k++) expect(d.has(name(k))).toBe(true)
    expect(d.has(name(10))).toBe(false)
    expect(d.engine.status.heldDeletes).toBe(50)
    expect(await trashCount(seeder)).toBe(0)
  })

  it('files nothing when there is nothing held to decide about', async () => {
    const { d } = await vaultOf('guard-nothing', 20)
    expect((await d.engine.decideDeletes('restore', [])).decided).toBe(0)
    expect(await d.engine.decideDeletes('confirm', ['no-such-id'])).toEqual({
      decided: 0,
      report: null,
    })
    expect(await d.state.getMeta('delete-decision')).toBeNull()
    const report = await d.sync()
    expect(report.pull.bootstrapped).toBe(false)
  })

  it('keeps a held path clear of the first pull on a host whose watcher reports', async () => {
    const { seeder, d } = await vaultOf('guard-watching', 40)
    const synced = new Promise<void>((resolve) => {
      const off = d.engine.onStatus((status) => {
        if (status.state === 'idle' && status.lastSyncAt !== null) {
          off()
          resolve()
        }
      })
    })
    d.engine.start()
    try {
      await synced
      for (let k = 0; k < 20; k++) await d.rm(name(k))
      await d.engine.sync()
      expect(d.engine.status.heldDeletes).toBe(20)

      const item = (await seeder.manifest(null)).items.find((it) => it.path === name(3))
      if (item === undefined) throw new Error('no n003 on the server')
      await seed(seeder, [
        {
          op: 'modify',
          file_id: item.file_id,
          base_version_id: item.version_id,
          ...(await blob(seeder, 'edited elsewhere\n')),
          mtime: 5,
        },
      ])
      await d.engine.sync()
      expect(d.has(name(3))).toBe(false)
      expect(d.engine.status.heldDeletes).toBe(20)
    } finally {
      await d.engine.stop()
    }
  })

  it('does not walk the whole vault on every sync for a held file edited elsewhere', async () => {
    const { seeder, d } = await vaultOf('guard-no-walk-loop', 40)
    for (let k = 0; k < 20; k++) await d.rm(name(k))
    await d.sync()
    const item = (await seeder.manifest(null)).items.find((it) => it.path === name(3))
    if (item === undefined) throw new Error('no n003 on the server')
    await seed(seeder, [
      {
        op: 'modify',
        file_id: item.file_id,
        base_version_id: item.version_id,
        ...(await blob(seeder, 'edited elsewhere\n')),
        mtime: 5,
      },
    ])
    await d.rescan()
    expect(await d.cursor()).toBeGreaterThan(0)
    const next = await d.sync()
    expect(next.pull.bootstrapped).toBe(false)
    expect(d.has(name(3))).toBe(false)
    expect(d.engine.status.heldDeletes).toBe(20)

    // The file put back by hand, with no decision: the edit it was held from still arrives.
    await d.write(name(3), 'note 3\n')
    await d.sync()
    await d.sync()
    expect(await d.text(name(3))).toBe('edited elsewhere\n')
    expect(d.engine.status.heldDeletes).toBe(19)

    // A confirm sends the rest; the edit made elsewhere is not among them.
    await d.engine.decideDeletes(
      'confirm',
      (await d.engine.heldDeletes()).map((one) => one.fileId)
    )
    expect(await trashCount(seeder)).toBe(19)
    await d.assertStateMatchesDisk()
  })
})
