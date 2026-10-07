import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EngineError } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { create, seed } from '../helpers/seed.js'

/**
 * A host whose claim on the vault lapses mid-run: the run stops at the
 * next commit, disk write or state write, and leaves nothing of its own behind after that.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

async function device(name: string, held: { now: boolean }) {
  const { vaultId } = await h.vault(account, name)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const { deviceToken } = await h.device(account, vaultId, 'daemon')
  const d = new Device(h, vaultId, deviceToken, 'daemon', { stillHeld: () => held.now })
  return { seeder, d }
}

describe('an engine whose host no longer holds the vault', () => {
  it('writes nothing it pulled once the claim lapsed while the bytes were on their way', async () => {
    const held = { now: true }
    const { seeder, d } = await device('held-pull', held)
    await seed(seeder, [
      await create(seeder, 'note.md', 'from the server\n'),
      await create(seeder, 'other.md', 'and another\n'),
    ])
    const getBlob = d.client.getBlob.bind(d.client)
    d.client.getBlob = async (sha) => {
      held.now = false
      return getBlob(sha)
    }
    const failed = await d.sync().catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(EngineError)
    // Its own code, which no step takes for something in the way.
    expect(failed).toMatchObject({ code: 'lost' })
    expect(d.lines.join('\n')).not.toMatch(/cannot be written|holding/)
    expect(d.has('note.md')).toBe(false)
    expect(await d.state.get('note.md')).toBeNull()
    expect(await d.cursor()).toBe(0)
  })

  it('commits nothing once the claim lapsed during the upload, and syncs again once held', async () => {
    const held = { now: true }
    const { seeder, d } = await device('held-push', held)
    await d.write('mine.md', 'typed here\n')
    const putBlob = d.client.putBlob.bind(d.client)
    d.client.putBlob = async (sha, bytes) => {
      held.now = false
      await putBlob(sha, bytes)
    }
    await expect(d.sync()).rejects.toMatchObject({ code: 'lost' })
    expect(d.stats.commits).toBe(0)
    // Left as a crash leaves it, for whoever holds the vault next to replay.
    expect(await d.state.getJournal()).not.toBeNull()
    expect((await seeder.manifest(null)).items.map((item) => item.path)).not.toContain('mine.md')

    d.client.putBlob = putBlob
    held.now = true
    await d.sync()
    expect((await seeder.manifest(null)).items.map((item) => item.path)).toContain('mine.md')
    await d.assertStateMatchesDisk()
  })

  it('files no scope or aside mark once the claim lapsed before the run began', async () => {
    const held = { now: true }
    const { seeder, d } = await device('held-marks', held)
    await seed(seeder, [await create(seeder, 'note.md', 'from the server\n')])
    await d.sync()
    const writes: string[] = []
    const state = d.state as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const name of ['put', 'delete', 'setCursor', 'setJournal', 'setMeta']) {
      const real = state[name]?.bind(d.state)
      if (real === undefined) continue
      state[name] = (...args: unknown[]) => {
        writes.push(`${name} ${String(args[0])}`)
        return real(...args)
      }
    }
    held.now = false
    await expect(d.sync()).rejects.toMatchObject({ code: 'lost' })
    expect(writes).toEqual([])
    // The marking stopped the run; it was not logged as a failure and walked past.
    expect(d.lines.join('\n')).not.toContain('scope: not recorded')
  })
})
