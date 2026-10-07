import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { VaultClient } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { blob, create, seed } from '../helpers/seed.js'

/**
 * The delete guard's loose ends: a held file
 * deleted elsewhere too is settled, a confirm forgets that a walk passed over a held path, a
 * push cut off half way still counts the deletes it sent, a decision says how many it decided,
 * and the hold's log line says what tripped it.
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

/** A vault of `n` notes, synced down to a device. */
async function vaultOf(label: string, n: number): Promise<{ seeder: VaultClient; d: Device }> {
  const { vaultId } = await h.vault(account, label)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const ops = []
  for (let k = 0; k < n; k++) ops.push(await create(seeder, name(k), `note ${k}\n`))
  await seed(seeder, ops)
  const { deviceToken } = await h.device(account, vaultId, 'laptop')
  const d = new Device(h, vaultId, deviceToken, 'laptop')
  await d.sync()
  return { seeder, d }
}

async function item(seeder: VaultClient, path: string) {
  const found = (await seeder.manifest(null)).items.find((one) => one.path === path)
  if (found === undefined) throw new Error(`no ${path} on the server`)
  return found
}

describe('the delete guard', () => {
  it('settles a held delete of a file deleted elsewhere too, and keeps the cursor moving', async () => {
    const { seeder, d } = await vaultOf('guard-both-gone', 40)
    for (let k = 0; k < 20; k++) await d.rm(name(k))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(20)

    const three = await item(seeder, name(3))
    await seed(seeder, [
      { op: 'delete', file_id: three.file_id, base_version_id: three.version_id },
    ])
    const report = await d.sync()

    expect(report.pull.held).toEqual([])
    expect(await d.cursor()).toBe(d.engine.status.headSeq)
    expect(d.engine.status.heldDeletes).toBe(19)
    expect((await d.engine.heldDeletes()).map((one) => one.path)).not.toContain(name(3))
    expect(await d.state.get(name(3))).toBeNull()
    expect(d.lines.join('\n')).toContain(`pull: ${name(3)} was deleted elsewhere too`)
    // The next sync reads nothing again.
    const next = await d.sync()
    expect(next.pull.held).toEqual([])
    expect(d.engine.status.heldDeletes).toBe(19)
  })

  it('forgets that a walk passed over a held path once the hold is empty', async () => {
    const { seeder, d } = await vaultOf('guard-noted-confirm', 40)
    for (let k = 0; k < 20; k++) await d.rm(name(k))
    await d.sync()
    const three = await item(seeder, name(3))
    await seed(seeder, [
      {
        op: 'modify',
        file_id: three.file_id,
        base_version_id: three.version_id,
        ...(await blob(seeder, 'edited elsewhere\n')),
        mtime: 5,
      },
    ])
    await d.rescan()
    expect(await d.state.getMeta!('held-noted')).not.toBeNull()

    const { decided } = await d.engine.decideDeletes(
      'confirm',
      (await d.engine.heldDeletes()).map((one) => one.fileId)
    )
    expect(decided).toBe(20)
    expect(d.engine.status.heldDeletes).toBe(0)
    expect(await d.state.getMeta!('held-noted')).toBeNull()
  })

  it('counts the deletes a push sent before it was cut off', async () => {
    const { d } = await vaultOf('guard-tally-partial', 20)
    for (let k = 0; k < 5; k++) await d.rm(name(k))
    // A thousand new files: the push goes in two commits, the deletes in the first.
    for (let k = 0; k < 1000; k++) await d.write(`new/f${k}.md`, `the same\n`)
    const commitRaw = d.client.commitRaw
    let commits = 0
    d.client.commitRaw = async (ops, key) => {
      if (++commits === 2) throw new TypeError('fetch failed')
      return commitRaw(ops, key)
    }
    await expect(d.sync()).rejects.toThrow('fetch failed')
    d.client.commitRaw = commitRaw

    const recent = JSON.parse((await d.state.getMeta!('recent-deletes')) ?? '[]') as Array<
      [number, number]
    >
    expect(recent.reduce((sum, [, count]) => sum + count, 0)).toBe(5)
  })

  it('counts the deletes of a batch the server took before the answer was lost, once replayed', async () => {
    const { d } = await vaultOf('guard-tally-replay', 20)
    for (let k = 0; k < 5; k++) await d.rm(name(k))
    // The commit lands on the server, and the answer never reaches the device.
    const commitRaw = d.client.commitRaw
    d.client.commitRaw = async (ops, key) => {
      d.client.commitRaw = commitRaw
      await commitRaw(ops, key)
      throw new TypeError('fetch failed')
    }
    await expect(d.sync()).rejects.toThrow('fetch failed')
    expect(await d.state.getJournal()).not.toBeNull()

    const report = await d.sync()
    expect(report.push.replayed).toBe(true)
    const recent = JSON.parse((await d.state.getMeta!('recent-deletes')) ?? '[]') as Array<
      [number, number]
    >
    expect(recent.reduce((sum, [, count]) => sum + count, 0)).toBe(5)
  })

  it('says how many it decided, and nothing when none of it is held', async () => {
    const { d } = await vaultOf('guard-decided', 40)
    for (let k = 0; k < 20; k++) await d.rm(name(k))
    await d.sync()
    const ids = (await d.engine.heldDeletes()).map((one) => one.fileId)
    expect(await d.engine.decideDeletes('confirm', ['no-such-id'])).toEqual({
      decided: 0,
      report: null,
    })
    d.engine.pause()
    // Filed, and waiting for syncing to resume: not the same as "nothing to decide".
    expect(await d.engine.decideDeletes('confirm', ids.slice(0, 5))).toEqual({
      decided: 5,
      report: null,
    })
  })

  it('names the recent deletes when they are what tripped the hold', async () => {
    const { d } = await vaultOf('guard-trickle-line', 100)
    let k = 0
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await d.rm(name(k++))
      await d.sync()
    }
    await d.rm(name(k++))
    await d.sync()
    expect(d.engine.status.heldDeletes).toBe(1)
    expect(d.lines.join('\n')).toMatch(
      /push: held 1 deletions \(\d+% of the vault\); 24 more went out in the last 15 minutes/
    )
  })
})
