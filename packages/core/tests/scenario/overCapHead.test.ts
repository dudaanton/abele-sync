import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { selectiveDefaults, type VaultClient } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { blob, create, seed, setConflictMode, shaOf } from '../helpers/seed.js'

/**
 * A verdict whose head is over this device's cap is never written here, and the local copy is
 * never recorded against that head: the disk does not hold it.
 * Recorded against the head, a delete here would delete the vault's file, an edit would replace
 * it cleanly, and a raised cap would never bring it down.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

interface Pair {
  seeder: VaultClient
  seederToken: string
  vaultId: string
  joiner: Device
}

async function pair(name: string, cap: number, prefer?: 'mine' | 'theirs'): Promise<Pair> {
  const { vaultId } = await h.vault(account, name)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const { deviceToken } = await h.device(account, vaultId, 'joiner')
  const joiner = new Device(h, vaultId, deviceToken, 'joiner', {
    selective: { ...selectiveDefaults(), maxFileBytes: cap },
    ...(prefer === undefined ? {} : { joinPrefer: prefer }),
  })
  return { seeder, seederToken, vaultId, joiner }
}

/** The server's live file at a path, or undefined. */
async function live(client: VaultClient, path: string): Promise<{ size: number } | undefined> {
  return (await client.manifest(null)).items.find((item) => item.path === path)
}

/** The text of the server's live file at a path. */
async function headText(client: VaultClient, path: string): Promise<string> {
  const item = await live(client, path)
  const found = (await client.manifest(null)).items.find((it) => it.path === path)
  if (item === undefined || found?.sha == null) throw new Error(`no live ${path}`)
  return new TextDecoder().decode(await client.getBlob(found.sha))
}

const SERVER = 'server line\n'.repeat(20)

/** The seeder's note over the cap, and a small local one of the joiner's merged into it. */
async function merged(name: string): Promise<Pair> {
  const p = await pair(name, 100)
  await seed(p.seeder, [await create(p.seeder, 'big.md', SERVER, 100)])
  await p.joiner.write('big.md', 'local\n', 200)
  const report = await p.joiner.sync()
  expect(report.push.merged).toBe(1)
  // The merge holds both sides and is over the cap, so it is not written here.
  expect((await live(p.seeder, 'big.md'))?.size).toBe(SERVER.length + 'local\n'.length)
  expect(await p.joiner.text('big.md')).toBe('local\n')
  return p
}

describe('an over-cap head the server merged', () => {
  it('a local delete does not delete the merged note (P1)', async () => {
    const p = await merged('overcap-p1')
    await p.joiner.rm('big.md')
    await p.joiner.sync()
    expect(await live(p.seeder, 'big.md')).toBeDefined()
  })

  it('a raised cap brings the merged note down (P2)', async () => {
    const p = await merged('overcap-p2')
    p.joiner.selective.maxFileBytes = null
    await p.joiner.rescan()
    expect((await p.joiner.bytes('big.md'))?.length).toBe(SERVER.length + 'local\n'.length)
    await p.joiner.assertStateMatchesDisk()
  })

  it('a local edit does not replace the merged note cleanly (P5)', async () => {
    const p = await merged('overcap-p5')
    // The local copy is recorded against the bytes it sent, kept by the server as a version of
    // their own: the create had no base, so that version is the only one the disk derives from.
    const entry = await p.joiner.state.get('big.md')
    const versions = await p.seeder.versions(entry?.fileId ?? '', {})
    const kept = versions.find((v) => v.version_id === entry?.versionId)
    expect(kept?.sha).toBe(await shaOf('local\n'))
    expect(kept?.op).not.toBe('merge')

    await p.joiner.write('big.md', 'local edited\n', 300)
    await p.joiner.sync()
    const text = await headText(p.seeder, 'big.md')
    expect(text).toContain('local edited\n')
    expect(text.split('server line\n').length - 1).toBe(20)
    expect(text).not.toMatch(/^local\n/m)
  })

  it('a delete here that loses to the merged note drops the entry, and settles (Q2)', async () => {
    const p = await merged('overcap-q2')
    await p.joiner.rm('big.md')
    await p.joiner.sync()
    expect(await live(p.seeder, 'big.md')).toBeDefined()
    const again = await p.joiner.sync()
    expect(again.push.committed).toBeNull()
    expect(p.joiner.engine.status.pending).toBe(0)
    await p.joiner.assertStateMatchesDisk()
    expect(await p.joiner.state.get('big.md')).toBeNull()
  })

  it('settles: nothing is sent again, run after run', async () => {
    const p = await merged('overcap-settles')
    const again = await p.joiner.sync()
    expect(again.push.committed).toBeNull()
    expect(await p.joiner.text('big.md')).toBe('local\n')
  })
})

const TEN = Array.from({ length: 10 }, (_, k) => `server line ${k}\n`).join('')

/** A note of three lines here, and ten more lines on the server that put it over the cap. */
async function grown(name: string): Promise<Pair & { first: string }> {
  const p = await pair(name, 100)
  const answer = await seed(p.seeder, [
    await create(p.seeder, 'note.md', 'alpha\nbeta\ngamma\n', 1),
  ])
  const r = answer.results[0]
  if (r === undefined || r.status === 'rejected') throw new Error('no seed')
  await p.joiner.sync()
  expect(await p.joiner.text('note.md')).toBe('alpha\nbeta\ngamma\n')
  await seed(p.seeder, [
    {
      op: 'modify',
      file_id: r.file_id,
      base_version_id: r.version_id,
      ...(await blob(p.seeder, `alpha\nbeta\ngamma\n${TEN}`)),
      mtime: 2,
    },
  ])
  return { ...p, first: r.version_id }
}

describe('an edit here merged into a head over the cap', () => {
  it("a second edit keeps the other device's lines (Q1)", async () => {
    const p = await grown('overcap-q1')
    await p.joiner.write('note.md', 'ALPHA\nbeta\ngamma\n')
    await p.joiner.sync()
    expect(await headText(p.seeder, 'note.md')).toBe(`ALPHA\nbeta\ngamma\n${TEN}`)
    // Recorded against the version holding exactly what was sent, which the server kept.
    const entry = await p.joiner.state.get('note.md')
    const versions = await p.seeder.versions(entry?.fileId ?? '', {})
    expect(versions.find((v) => v.version_id === entry?.versionId)?.sha).toBe(
      await shaOf('ALPHA\nbeta\ngamma\n')
    )

    await p.joiner.write('note.md', 'ALPHA\nBETA\ngamma\n')
    await p.joiner.sync()
    expect(await headText(p.seeder, 'note.md')).toBe(`ALPHA\nBETA\ngamma\n${TEN}`)
    const again = await p.joiner.sync()
    expect(again.push.committed).toBeNull()
  })

  it('with no version holding the bytes sent, the edit is recorded against its own base', async () => {
    const p = await grown('overcap-q1-base')
    // A server that did not keep the sent text as a version of its own.
    const versions = p.joiner.client.versions.bind(p.joiner.client)
    const hidden = await shaOf('ALPHA\nbeta\ngamma\n')
    p.joiner.client.versions = async (fileId, opts) =>
      (await versions(fileId, opts)).filter((v) => v.sha !== hidden)
    await p.joiner.write('note.md', 'ALPHA\nbeta\ngamma\n')
    await p.joiner.sync()
    expect((await p.joiner.state.get('note.md'))?.versionId).toBe(p.first)

    await p.joiner.write('note.md', 'ALPHA\nBETA\ngamma\n')
    await p.joiner.sync()
    const text = await headText(p.seeder, 'note.md')
    expect(text).toContain(TEN)
    expect(text).toContain('BETA\n')
  })
})

describe('a fallback with no version holding the bytes sent', () => {
  it('a move is recorded against the entry it moved, not the version before the head', async () => {
    const p = await grown('overcap-move-base')
    await p.joiner.write('note.md', 'ALPHA\nbeta\ngamma\n')
    await p.joiner.sync()
    const kept = (await p.joiner.state.get('note.md'))?.versionId
    expect(kept).toBeDefined()
    // Retention pruned the version the entry names, or the server never listed it.
    const versions = p.joiner.client.versions.bind(p.joiner.client)
    const hidden = await shaOf('ALPHA\nbeta\ngamma\n')
    p.joiner.client.versions = async (fileId, opts) =>
      (await versions(fileId, opts)).filter((v) => v.sha !== hidden)
    await p.joiner.mv('note.md', 'moved.md')
    await p.joiner.sync()
    // The move comes back in the pull after the push; it is this device's own, not one out of scope.
    expect(await p.joiner.text('moved.md')).toBe('ALPHA\nbeta\ngamma\n')
    expect((await p.joiner.state.get('moved.md'))?.versionId).toBe(kept)

    await p.joiner.write('moved.md', 'ALPHA\nBETA\ngamma\n')
    await p.joiner.sync()
    const text = await headText(p.seeder, 'moved.md')
    expect(text).toContain(TEN)
    expect(text).toContain('BETA\n')
  })

  it('a create keeps no entry, so its next edit deletes nothing of the head', async () => {
    const p = await pair('overcap-create-none', 100)
    const lines = Array.from({ length: 20 }, (_, k) => `line ${k}\n`).join('')
    await seed(p.seeder, [await create(p.seeder, 'n.md', lines, 100)])
    // A server that did not keep the sent text as a version of its own.
    const versions = p.joiner.client.versions.bind(p.joiner.client)
    const hidden = await shaOf('line 17\nline 18\nline 19\nmine\n')
    p.joiner.client.versions = async (fileId, opts) =>
      (await versions(fileId, opts)).filter((v) => v.sha !== hidden)
    await p.joiner.write('n.md', 'line 17\nline 18\nline 19\nmine\n', 200)
    await p.joiner.sync()
    expect(await p.joiner.state.get('n.md')).toBeNull()

    await p.joiner.write('n.md', 'line 17\nline 18\nline 19\nmine edited\n')
    await p.joiner.sync()
    const text = await headText(p.seeder, 'n.md')
    for (let k = 0; k < 20; k++) expect(text).toContain(`line ${k}\n`)
    expect(text).toContain('mine edited\n')
  })
})

describe('a new file here merged into a head over the cap', () => {
  it("an edit of the joined copy keeps the seeder's lines (Q4)", async () => {
    const p = await pair('overcap-q4', 100)
    const lines = Array.from({ length: 20 }, (_, k) => `line ${k}\n`).join('')
    await seed(p.seeder, [await create(p.seeder, 'n.md', lines, 100)])
    await p.joiner.write('n.md', 'line 17\nline 18\nline 19\nmine\n', 200)
    await p.joiner.sync()
    await p.joiner.write('n.md', 'line 17\nline 18\nline 19\nmine edited\n')
    await p.joiner.sync()
    const text = await headText(p.seeder, 'n.md')
    for (let k = 0; k < 20; k++) expect(text).toContain(`line ${k}\n`)
    expect(text).toContain('mine edited\n')
    expect(text).not.toMatch(/^mine\n/m)
  })
})

describe('an over-cap head whose kept version is old (theirs)', () => {
  it('a local delete does not delete the newer server file (P4)', async () => {
    const p = await pair('overcap-p4', 100, 'theirs')
    const first = await seed(p.seeder, [await create(p.seeder, 'big.png', 'a'.repeat(10), 1)])
    const result = first.results[0]
    if (result === undefined || result.status === 'rejected') throw new Error('no seed')
    let base = result.version_id
    for (let i = 1; i <= 25; i++) {
      const content = i === 25 ? 'z'.repeat(205) : `${'b'.repeat(10)}${i}`
      const answer = await seed(p.seeder, [
        {
          op: 'modify',
          file_id: result.file_id,
          base_version_id: base,
          ...(await blob(p.seeder, content)),
          mtime: 1 + i,
        },
      ])
      const r = answer.results[0]
      if (r === undefined || r.status === 'rejected') throw new Error('no modify')
      base = r.version_id
    }
    await p.joiner.write('big.png', 'a'.repeat(10), 1)
    await p.joiner.sync()
    expect((await p.joiner.bytes('big.png'))?.length).toBe(10)

    await p.joiner.rm('big.png')
    await p.joiner.sync()
    expect((await live(p.seeder, 'big.png'))?.size).toBe(205)
  })
})

describe('an over-cap note copied aside by the server (conflict-file)', () => {
  it('the local file becomes the conflict copy, nothing is sent again, and a raised cap brings the head', async () => {
    const p = await pair('overcap-conflict', 100)
    await setConflictMode(h, p.seederToken, p.vaultId, 'conflict-file')
    await seed(p.seeder, [await create(p.seeder, 'big.md', SERVER, 100)])
    await p.joiner.write('big.md', 'local\n', 200)
    const report = await p.joiner.sync()
    expect(report.push.conflicts).toBe(1)

    const copies = async (): Promise<string[]> =>
      (await p.seeder.manifest(null)).items
        .map((item) => item.path)
        .filter((path) => path !== 'big.md')
    expect(await copies()).toHaveLength(1)
    const again = await p.joiner.sync()
    expect(again.push.committed).toBeNull()
    expect(await copies()).toHaveLength(1)
    await p.joiner.assertStateMatchesDisk()

    // What this device wrote is here, as the conflict copy that holds it; the head is not.
    const [copy] = await copies()
    expect(await p.joiner.text(copy ?? '')).toBe('local\n')
    expect(p.joiner.has('big.md')).toBe(false)

    p.joiner.selective.maxFileBytes = null
    await p.joiner.rescan()
    expect(await p.joiner.text('big.md')).toBe(SERVER)
    expect((await live(p.seeder, 'big.md'))?.size).toBe(SERVER.length)
    expect(await copies()).toHaveLength(1)
  })
})

/**
 * A local file over the cap at the path of a server file is passed
 * over, and the feed moves on. Once that local file goes, the server's file must still come.
 */
describe('a server file passed over for a local one over the cap', () => {
  it('comes down once the local file is gone', async () => {
    const p = await pair('overcap-aside-gone', 50)
    await seed(p.seeder, [await create(p.seeder, 'big.png', 's'.repeat(10), 100)])
    await p.joiner.write('big.png', 'l'.repeat(205), 200)
    await p.joiner.sync()
    expect((await p.joiner.bytes('big.png'))?.length).toBe(205)

    await p.joiner.rm('big.png')
    const after = await p.joiner.sync()
    expect(after.push.committed).toBeNull()
    expect((await p.joiner.bytes('big.png'))?.length).toBe(10)
    await p.joiner.assertStateMatchesDisk()
  })

  it('is marked before the pull saves a cursor past it', async () => {
    const p = await pair('overcap-aside-order', 50)
    await seed(p.seeder, [await create(p.seeder, 'big.png', 's'.repeat(10), 100)])
    await p.joiner.write('big.png', 'l'.repeat(205), 200)
    const order: string[] = []
    const setCursor = p.joiner.state.setCursor.bind(p.joiner.state)
    p.joiner.state.setCursor = async (seq) => {
      if (seq > 0) order.push('cursor')
      return setCursor(seq)
    }
    const setMeta = p.joiner.state.setMeta.bind(p.joiner.state)
    p.joiner.state.setMeta = async (key, value) => {
      if (key === 'passed-over-paths' && value !== null) order.push('mark')
      return setMeta(key, value)
    }
    await p.joiner.sync()
    expect(order[0]).toBe('mark')
    expect(order).toContain('cursor')
  })

  it('stays passed over, with no walk each run, while the local file is there', async () => {
    const p = await pair('overcap-aside-stays', 50)
    await seed(p.seeder, [await create(p.seeder, 'big.png', 's'.repeat(10), 100)])
    await p.joiner.write('big.png', 'l'.repeat(205), 200)
    await p.joiner.sync()
    const again = await p.joiner.sync()
    expect(again.pull.bootstrapped).toBe(false)
    expect((await p.joiner.bytes('big.png'))?.length).toBe(205)
  })
})
