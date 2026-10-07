import type { CommitOp } from '@abele/sync-protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encodeText, sha256, type VaultClient } from '../../src/index.js'
import { Device } from '../helpers/device.js'
import { BASE_URL, serverHarness, TEST_PASSWORD, type Harness } from '../helpers/harness.js'

/**
 * Files the server will not have, and how little the engine asks about them afterwards.
 *
 * The server here takes no file over a kilobyte, and no upload over that in one request
 * either, so a `PUT` of anything bigger is refused at the door with `too_large` — what a
 * body limit in front of a server does too. A vault's own cap and its quota are set through
 * the settings route: the cap is learned from the state and keeps the file off the wire
 * altogether, the quota is met at the commit. Whichever way a refusal comes, it comes once:
 * the engine remembers the sha, reports the op refused in the same words on every sync
 * after, and sends nothing for it until the bytes or the limits change.
 */

const SERVER_CAP = 1000

describe('the size cap and the quota', () => {
  let h: Harness
  let accountToken: string
  const started: Device[] = []

  interface Vault {
    vaultId: string
    deviceToken: string
    client: VaultClient
  }

  async function ownVault(name: string): Promise<Vault> {
    const { vaultId } = await h.vault(accountToken, name)
    const { deviceToken } = await h.device(accountToken, vaultId, `${name} device`)
    return { vaultId, deviceToken, client: h.clientFor(deviceToken, vaultId) }
  }

  function device(vault: Vault, name = 'device'): Device {
    const d = new Device(h, vault.vaultId, vault.deviceToken, name)
    started.push(d)
    return d
  }

  /** The vault's settings, patched the way an owner would patch them. */
  async function settings(vault: Vault, patch: Record<string, unknown>): Promise<void> {
    const response = await h.fetch(`${BASE_URL}/v1/vaults/${vault.vaultId}/settings`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${vault.deviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(patch),
    })
    if (!response.ok) throw new Error(`settings answered ${response.status}`)
  }

  let seeds = 0
  const seed = (client: VaultClient, ops: CommitOp[]): Promise<unknown> =>
    client.commit(ops, `cap-seed-${++seeds}`)

  beforeAll(async () => {
    h = await serverHarness({ maxFileBytes: SERVER_CAP, simpleUploadBytes: SERVER_CAP })
    accountToken = (await h.account('cap@abele.test')).accountToken
  })

  afterEach(async () => {
    for (const d of started.splice(0)) await d.engine.stop()
  })

  afterAll(async () => {
    await h.close()
  })

  it('asks the server once about a file it will not take, and reports it refused every time', async () => {
    const vault = await ownVault('server-cap')
    const d = device(vault)
    await d.write('big.md', 'x'.repeat(5 * SERVER_CAP))
    await d.write('small.md', 'fits')

    const first = await d.sync()

    expect(first.push.rejected.map((r) => [r.code, r.op.op])).toEqual([['too_large', 'create']])
    expect(first.push).toMatchObject({ applied: 1 })
    expect(d.stats).toMatchObject({ blobHeads: 2, blobPuts: 2, commits: 1 })
    expect(d.engine.status.pending).toBe(1)
    const said = first.push.rejected[0]!.message

    // Two more syncs: the same refusal, in the same words, and not one more request for it.
    for (const round of [2, 3]) {
      const again = await d.sync()
      expect(
        again.push.rejected.map((r) => [r.code, r.message]),
        `round ${round}`
      ).toEqual([['too_large', said]])
      expect(again.push.committed).toBeNull()
      expect(d.stats).toMatchObject({ blobHeads: 2, blobPuts: 2, commits: 1 })
      expect(d.engine.status.pending).toBe(1)
    }
    expect(d.paths()).toEqual(['big.md', 'small.md'])

    // Different bytes are a different file, and get their own try.
    await d.write('big.md', 'trimmed down')
    const shrunk = await d.sync()
    expect(shrunk.push).toMatchObject({ applied: 1, rejected: [] })
    expect(d.stats).toMatchObject({ blobHeads: 3, blobPuts: 3, commits: 2 })
    expect(d.engine.status.pending).toBe(0)
  })

  it('learns the vault cap from the state and excludes what is over it, both ways', async () => {
    const vault = await ownVault('vault-cap')
    const theirs = encodeText('y'.repeat(500))
    const theirSha = await sha256(theirs)
    await vault.client.putBlob(theirSha, theirs)
    await seed(vault.client, [
      { op: 'create', path: 'theirs.md', sha: theirSha, size: theirs.length, mtime: 100 },
    ])
    await settings(vault, { max_file_bytes: 300 })
    const d = device(vault)
    await d.write('mine.md', 'z'.repeat(500))
    await d.write('small.md', 'fits')

    const report = await d.sync()

    // Neither the local file nor the remote one crossed the wire: no upload, no download,
    // no refusal to report, nothing pending.
    expect(report.push).toMatchObject({ applied: 1, rejected: [] })
    expect(report.pull.skipped).toBeGreaterThanOrEqual(1)
    expect(d.stats).toMatchObject({ blobPuts: 1, blobGets: 0, commits: 1 })
    expect(d.paths()).toEqual(['mine.md', 'small.md'])
    expect(d.engine.status.pending).toBe(0)

    // The cap raised: the next run walks the manifest again, as any widening does, and both
    // files go through.
    await settings(vault, { max_file_bytes: 1000 })
    const widened = await d.rescan()
    expect(widened.push).toMatchObject({ applied: 1, rejected: [] })
    expect(widened.pull.applied).toBe(1)
    expect(d.paths()).toEqual(['mine.md', 'small.md', 'theirs.md'])
    expect(d.stats).toMatchObject({ blobPuts: 2, blobGets: 1, commits: 2 })
  })

  it('remembers a quota refusal until the quota changes', async () => {
    const vault = await ownVault('quota')
    await settings(vault, { quota_bytes: 100, account_password: TEST_PASSWORD })
    const d = device(vault)
    await d.write('note.md', 'q'.repeat(200))

    // The upload itself is refused: bytes nobody has committed count against the quota too.
    const first = await d.sync()
    expect(first.push.rejected.map((r) => r.code)).toEqual(['quota_exceeded'])
    expect(d.stats).toMatchObject({ blobHeads: 1, blobPuts: 1, commits: 0 })

    const second = await d.sync()
    expect(second.push.rejected.map((r) => r.code)).toEqual(['quota_exceeded'])
    expect(second.push.committed).toBeNull()
    expect(d.stats).toMatchObject({ blobHeads: 1, blobPuts: 1, commits: 0 })

    // Room made: the refusal is forgotten and the file goes up.
    await settings(vault, { quota_bytes: null, account_password: TEST_PASSWORD })
    const third = await d.sync()
    expect(third.push).toMatchObject({ applied: 1, rejected: [] })
    expect(d.stats).toMatchObject({ commits: 1 })
    expect(d.engine.status.pending).toBe(0)
  })
  it('asks again about an upload turned away only because other uploads filled the quota', async () => {
    const vault = await ownVault('waiting')
    await settings(vault, { quota_bytes: 100, account_password: TEST_PASSWORD })
    // Another device of the vault has 80 bytes up and has not committed them.
    const other = await h.device(accountToken, vault.vaultId, 'other')
    const theirs = encodeText('o'.repeat(80))
    await h.clientFor(other.deviceToken, vault.vaultId).putBlob(await sha256(theirs), theirs)

    const d = device(vault)
    await d.write('note.md', 'w'.repeat(30))
    const first = await d.sync()
    expect(first.push.rejected.map((r) => r.code)).toEqual(['quota_waiting'])
    expect(d.stats).toMatchObject({ blobPuts: 1, commits: 0 })

    // The other device goes, and its uploads with it: now there is room, and the file goes up.
    const revoked = await h.fetch(`${BASE_URL}/v1/devices/${other.deviceId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accountToken}` },
    })
    expect(revoked.status).toBe(204)
    const second = await d.sync()
    expect(second.push).toMatchObject({ applied: 1, rejected: [] })
    expect(d.stats).toMatchObject({ blobPuts: 2, commits: 1 })
  })
})
