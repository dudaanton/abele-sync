import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { CommitOp } from '@abele/sync-protocol'
import {
  joinFinished,
  MemoryFileSystem,
  MemoryStateStore,
  type VaultClient,
} from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { create, seed } from '../helpers/seed.js'

/**
 * A join cut off after its first pull moved the cursor and before its push was answered. The side the person chose is for every create of the join, so a restart
 * that finds the cursor above 0 must still be joining — which only the state can tell it — and
 * the report says the join is done once, for the run whose push carried the choice.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

interface Setup {
  seeder: VaultClient
  vaultId: string
  deviceToken: string
  fs: MemoryFileSystem
  state: MemoryStateStore
  /** Every create sent. */
  sent: CommitOp[]
  /** A device over the same disk and state: the same device in a fresh process. */
  device(opts: { prefer?: 'mine' | 'theirs' }): Device
}

async function setup(name: string): Promise<Setup> {
  const { vaultId } = await h.vault(account, name)
  const seeder = h.clientFor((await h.device(account, vaultId, 'seeder')).deviceToken, vaultId)
  const { deviceToken } = await h.device(account, vaultId, 'joiner')
  const fs = new MemoryFileSystem()
  const state = new MemoryStateStore()
  const sent: CommitOp[] = []
  const device = ({ prefer }: { prefer?: 'mine' | 'theirs' }) => {
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(href).pathname.endsWith('/commit')) {
        const ops = (JSON.parse(String(init?.body)) as { ops: CommitOp[] }).ops
        sent.push(...ops.filter((op) => op.op === 'create'))
      }
      return h.fetch(input, init)
    }
    return new Device(h, vaultId, deviceToken, 'joiner', {
      fs,
      state,
      fetch,
      ...(prefer === undefined ? {} : { joinPrefer: prefer }),
    })
  }
  return { seeder, vaultId, deviceToken, fs, state, sent, device }
}

/** The server's bytes at a path, as text. */
async function serverText(client: VaultClient, path: string): Promise<string | undefined> {
  const item = (await client.manifest(null)).items.find((i) => i.path === path)
  if (item?.sha == null) return undefined
  return new TextDecoder().decode(await client.getBlob(item.sha))
}

describe('a join cut off after its first pull', () => {
  it('finishes with the chosen side after a restart, and says it is done once', async () => {
    const s = await setup('join-marker')
    // One file only the server has, so the first pull has something to move the cursor past,
    // and one only this device has, which its push is to create.
    await seed(s.seeder, [await create(s.seeder, 'Other.md', 'server only\n', 100)])
    await s.fs.writeAtomic('Shared.png', new TextEncoder().encode('local bytes'), 50)

    // The first run pulls, and its scan fails: nothing is journalled, nothing is sent.
    const list = s.fs.list.bind(s.fs)
    s.fs.list = async function* () {
      if ((await s.state.getCursor()) > 0) throw new Error('the disk would not be read')
      yield* list()
    }
    const first = s.device({ prefer: 'mine' })
    await expect(first.sync()).rejects.toThrow('the disk would not be read')
    s.fs.list = list
    expect(await s.state.getCursor()).toBeGreaterThan(0)
    expect(await s.state.getJournal()).toBeNull()
    expect(s.sent).toEqual([])

    // Meanwhile another device puts newer bytes at that path: without the choice, they win.
    await seed(s.seeder, [await create(s.seeder, 'Shared.png', 'server bytes', 100)])

    // A fresh process, the same choice: the create still carries it, and wins.
    s.sent.length = 0
    const second = s.device({ prefer: 'mine' })
    const report = await second.sync()
    const shared = s.sent.filter((op) => op.op === 'create' && op.path === 'Shared.png')
    expect(shared).toEqual([expect.objectContaining({ prefer: 'mine' })])
    expect(await serverText(s.seeder, 'Shared.png')).toBe('local bytes')
    expect(report.joined).toBe(true)
    expect(joinFinished(report)).toBe(true)

    // Done: the next run says nothing of a join.
    const after = await second.sync()
    expect(after.joined).toBe(false)
    expect(joinFinished(after)).toBe(false)

    // A host that did not forget the choice: a fresh process sends it no more.
    await seed(s.seeder, [await create(s.seeder, 'Late.png', 'server late', 100)])
    await s.fs.writeAtomic('Late.png', new TextEncoder().encode('local late'), 300)
    s.sent.length = 0
    const third = s.device({ prefer: 'mine' })
    const late = await third.sync()
    expect(late.joined).toBe(false)
    const lateCreates = s.sent.filter((op) => op.op === 'create' && op.path === 'Late.png')
    expect(lateCreates.length).toBeGreaterThan(0)
    for (const op of lateCreates) expect(op).not.toHaveProperty('prefer')
  })
})
