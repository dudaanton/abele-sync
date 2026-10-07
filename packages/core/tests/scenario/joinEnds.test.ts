import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { CommitOp } from '@abele/sync-protocol'
import { joinFinished, selectiveDefaults, type VaultClient } from '../../src/index.js'
import { BASE_URL, serverHarness, TEST_PASSWORD, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { create, seed } from '../helpers/seed.js'

/**
 * A join ends once its creates have been answered, whatever the pulls still hold: the preference is for the join and nothing after it. And this device's size cap
 * holds through a join: a server file over it is never written onto this disk, and a local file
 * over it never keeps the server's file at that path out.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

interface Joining {
  seeder: VaultClient
  joiner: Device
  /** Every create the joiner sent, as it left. */
  sent: CommitOp[]
  settings(patch: Record<string, unknown>): Promise<void>
}

async function joining(
  name: string,
  prefer: 'mine' | 'theirs' | undefined,
  maxFileBytes: number | null = null
): Promise<Joining> {
  const { vaultId } = await h.vault(account, name)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const { deviceToken } = await h.device(account, vaultId, 'joiner')
  const sent: CommitOp[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(href).pathname.endsWith('/commit')) {
      const ops = (JSON.parse(String(init?.body)) as { ops: CommitOp[] }).ops
      sent.push(...ops.filter((op) => op.op === 'create'))
    }
    return h.fetch(input, init)
  }
  const joiner = new Device(h, vaultId, deviceToken, 'joiner', {
    selective: { ...selectiveDefaults(), maxFileBytes },
    fetch,
    ...(prefer === undefined ? {} : { joinPrefer: prefer }),
  })
  const settings = async (patch: Record<string, unknown>): Promise<void> => {
    const response = await h.fetch(`${BASE_URL}/v1/vaults/${vaultId}/settings`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${seederToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!response.ok) throw new Error(`settings answered ${response.status}`)
  }
  return { seeder, joiner, sent, settings }
}

const bytes = (n: number, fill: string): Uint8Array => new TextEncoder().encode(fill.repeat(n))

/** The server's head for a path: its bytes' size, or undefined when the path is not live. */
async function headSize(client: VaultClient, path: string): Promise<number | undefined> {
  return (await client.manifest(null)).items.find((item) => item.path === path)?.size
}

/** After the join: the seeder and the joiner both write `Late.md`, and the joiner syncs. */
async function lateRace(j: Joining): Promise<void> {
  await seed(j.seeder, [await create(j.seeder, 'Late.md', 'server late\n', 100)])
  await j.joiner.write('Late.md', 'local late\n', 200)
  j.sent.length = 0
  await j.joiner.sync()
}

describe('a join that leaves something held for good', () => {
  it('ends anyway: joinFinished says so, and a later race is merged, not preferred', async () => {
    const j = await joining('join-ends-quota', 'mine')
    await seed(j.seeder, [await create(j.seeder, 'q.png', bytes(10, 's'), 100)])
    await j.settings({ quota_bytes: 60, account_password: TEST_PASSWORD })
    // Over the quota as a replacement head: refused for good, so the server's q.png is held.
    await j.joiner.write('q.png', bytes(300, 'l'), 200)

    const report = await j.joiner.sync()
    expect(report.push.rejected.map((r) => r.code)).toEqual(['quota_exceeded'])
    expect((report.secondPull ?? report.pull).held.map((c) => c.path)).toEqual(['q.png'])
    expect(joinFinished(report)).toBe(true)

    await lateRace(j)
    const late = j.sent.filter((op) => op.op === 'create' && op.path === 'Late.md')
    expect(late).toHaveLength(1)
    expect(late[0]).not.toHaveProperty('prefer')
    expect(await j.joiner.text('Late.md')).toBe('server late\nlocal late\n')
  })
})

describe('this device’s cap through a join', () => {
  it('a local file over the cap does not keep the server’s file at that path held', async () => {
    const j = await joining('join-ends-cap-local', 'mine', 50)
    await seed(j.seeder, [await create(j.seeder, 'big.png', bytes(10, 's'), 100)])
    await j.joiner.write('big.png', bytes(205, 'l'), 200)

    const report = await j.joiner.sync()
    expect(report.pull.held).toEqual([])
    expect(joinFinished(report)).toBe(true)
    // Excluded here, so untouched on both sides.
    expect((await j.joiner.bytes('big.png'))?.length).toBe(205)
    expect(await headSize(j.seeder, 'big.png')).toBe(10)
    expect(j.sent.filter((op) => op.op === 'create' && op.path === 'big.png')).toEqual([])

    await lateRace(j)
    expect(await j.joiner.text('Late.md')).toBe('server late\nlocal late\n')
  })

  for (const prefer of ['theirs', undefined] as const) {
    it(`a server head over the cap is never written here (${prefer ?? 'merge, the server newer'})`, async () => {
      const j = await joining(`join-ends-cap-head-${prefer ?? 'merge'}`, prefer, 100)
      await seed(j.seeder, [await create(j.seeder, 'big.png', bytes(205, 's'), 300)])
      await j.joiner.write('big.png', bytes(10, 'l'), 100)

      const report = await j.joiner.sync()
      expect(joinFinished(report)).toBe(true)
      // The server kept its head, and this device's copy stays as it was.
      expect(await headSize(j.seeder, 'big.png')).toBe(205)
      expect((await j.joiner.bytes('big.png'))?.length).toBe(10)
      await j.joiner.assertStateMatchesDisk()

      // Settled: nothing is sent again, run after run.
      const again = await j.joiner.sync()
      expect(again.push.committed).toBeNull()
      expect((await j.joiner.bytes('big.png'))?.length).toBe(10)

      // The cap raised, the head comes down.
      j.joiner.selective.maxFileBytes = null
      await j.joiner.rescan()
      expect((await j.joiner.bytes('big.png'))?.length).toBe(205)
    })
  }
})
