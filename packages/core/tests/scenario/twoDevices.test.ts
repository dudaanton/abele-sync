import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge } from '../helpers/device.js'
import { blob, seed, shaOf } from '../helpers/seed.js'

let h: Harness, account: string, v: string, laptop: Device, phone: Device

const device = async (name: string, vaultId = v): Promise<Device> => {
  const { deviceToken } = await h.device(account, vaultId, name)
  return new Device(h, vaultId, deviceToken, name)
}

const listing = (d: Device): Array<[string, string]> =>
  [...d.fs.snapshot()]
    .map(([path, bytes]): [string, string] => [path, Buffer.from(bytes).toString('hex')])
    .sort()

/** The urls one sync asked the server for, by the route in question. */
const urlsOf = (spy: ReturnType<typeof vi.spyOn>, route: string): string[] =>
  spy.mock.calls
    .map((call: unknown[]) => (call[0] as { url: string }).url)
    .filter((u: string) => u.includes(route))

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
  v = (await h.vault(account)).vaultId
  laptop = await device('laptop')
  phone = await device('phone')
})
afterAll(async () => {
  await h.close()
})

describe('two devices', () => {
  const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(64)])

  it('laptop creates 3 notes and an image; phone syncs to an identical disk with 4 downloads', async () => {
    await laptop.write('A.md', '# a\n')
    await laptop.write('B.md', '# b\n')
    await laptop.write('C.md', '# c\n')
    await laptop.write('pic.png', image)
    const pushed = (await laptop.sync()).push.committed
    expect(pushed?.results.map((r) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ])
    expect(laptop.stats).toEqual({ blobPuts: 4, blobHeads: 4, blobGets: 0, commits: 1 })

    expect((await phone.sync()).push.committed).toBeNull()
    expect(listing(phone)).toEqual(listing(laptop))
    expect(phone.stats.blobGets).toBe(4)
    expect(await phone.cursor()).toBe(4)
    expect(await phone.state.get('pic.png')).toMatchObject({ sha: await shaOf(image) })
  })

  it('phone edits a note and renames the image; laptop downloads the note, not the image', async () => {
    await phone.write('A.md', '# a, edited on the phone\n')
    await phone.mv('pic.png', 'img/pic.png')
    const pushed = (await phone.sync()).push.committed
    expect(pushed?.results.map((r) => [r.status, (r as { path?: string }).path])).toEqual([
      ['applied', 'img/pic.png'],
      ['applied', 'A.md'],
    ])

    const before = laptop.stats.blobGets
    await laptop.sync()
    expect(await laptop.text('A.md')).toBe('# a, edited on the phone\n')
    expect(laptop.has('pic.png')).toBe(false)
    expect(await laptop.holds('img/pic.png', image)).toBe(true)
    expect(laptop.stats.blobGets).toBe(before + 1)
    expect(listing(laptop)).toEqual(listing(phone))
  })

  it('laptop deletes a note; phone syncs and it is gone', async () => {
    await laptop.rm('B.md')
    const pushed = (await laptop.sync()).push.committed
    expect(pushed?.results).toEqual([expect.objectContaining({ status: 'applied', path: 'B.md' })])
    await phone.sync()
    expect(phone.has('B.md')).toBe(false)
    expect(await phone.state.get('B.md')).toBeNull()
    expect(listing(phone)).toEqual(listing(laptop))
  })

  it('laptop writes the same note twice between syncs: one commit, one modify, the last content', async () => {
    const observer = h.clientFor((await h.device(account, v)).deviceToken, v)
    const { head_seq: before } = await observer.state()
    const commits = laptop.stats.commits
    await laptop.write('C.md', '# c, second draft\n')
    await laptop.write('C.md', '# c, final\n')
    const pushed = (await laptop.sync()).push.committed
    expect(laptop.stats.commits).toBe(commits + 1)
    expect(pushed?.results).toEqual([expect.objectContaining({ status: 'applied', path: 'C.md' })])
    expect(pushed?.head_seq).toBe(before + 1)

    const feed = await observer.changes(before)
    expect(feed.items).toEqual([
      expect.objectContaining({ op: 'modify', path: 'C.md', sha: await shaOf('# c, final\n') }),
    ])
    await phone.sync()
    expect(await phone.text('C.md')).toBe('# c, final\n')
    await converge(laptop, phone)
  })

  it('a device that never synced bootstraps 1500 files from the paged manifest, then follows changes', async () => {
    const big = (await h.vault(account, 'Big')).vaultId
    const seeder = h.clientFor((await h.device(account, big, 'seeder')).deviceToken, big)
    const text = 'the same text in every note\n'
    // One upload behind every seeded file: the seeding is not what this test measures.
    const body = await blob(seeder, text)
    const paths = Array.from({ length: 1500 }, (_, i) => `notes/${String(i).padStart(4, '0')}.md`)
    for (const batch of [paths.slice(0, 750), paths.slice(750)]) {
      const r = await seed(
        seeder,
        batch.map((path) => ({ op: 'create', path, ...body, mtime: 1 }))
      )
      expect(r.results.every((x) => x.status === 'applied')).toBe(true)
    }

    const inject = vi.spyOn(h.app, 'inject')
    const newcomer = await device('newcomer', big)
    const work = counting(newcomer)
    expect((await newcomer.sync()).push.committed).toBeNull()
    expectLinear(work, 1500)
    expect(urlsOf(inject, '/manifest')).toHaveLength(2)
    expect(urlsOf(inject, '/changes')).toEqual([`/v1/vaults/${big}/changes?since=1500&limit=1000`])
    inject.mockRestore()
    expect(await newcomer.cursor()).toBe(1500)
    expect(newcomer.fs.snapshot().size).toBe(1500)
    expect(await entries(newcomer)).toBe(1500)
    expect(newcomer.paths()).toEqual(paths)
    expect(await newcomer.text('notes/1499.md')).toBe(text)
    // One blob behind 1500 files: fetched once, then found on the disk.
    expect(newcomer.stats).toEqual({ blobPuts: 0, blobHeads: 0, blobGets: 1, commits: 0 })

    // From here the feed: 1001 more files, one page and one item over.
    const more = Array.from({ length: 1001 }, (_, i) => `more/${String(i).padStart(4, '0')}.md`)
    const another = await blob(seeder, 'one more\n')
    for (const batch of [more.slice(0, 1000), more.slice(1000)]) {
      await seed(
        seeder,
        batch.map((path) => ({ op: 'create', path, ...another, mtime: 1 }))
      )
    }
    const follow = vi.spyOn(h.app, 'inject')
    work.clear()
    expect((await newcomer.sync()).push.committed).toBeNull()
    // Measured against the 1001 new files, not the 2501 the state then holds.
    expectLinear(work, 1001)
    expect(urlsOf(follow, '/manifest')).toHaveLength(0)
    expect(urlsOf(follow, '/changes')).toEqual([
      `/v1/vaults/${big}/changes?since=1500&limit=1000`,
      `/v1/vaults/${big}/changes?since=2500&limit=1000`,
    ])
    follow.mockRestore()
    expect(await newcomer.cursor()).toBe(2501)
    expect(newcomer.fs.snapshot().size).toBe(2501)
    expect(await newcomer.text('more/1000.md')).toBe('one more\n')
    expect(newcomer.stats.blobGets).toBe(2)
    // A hang guard only: what the sync costs is asserted above, by count, not by the clock.
  }, 60_000)

  it('a device that never synced reads the manifest, not the history, however short it is', async () => {
    const small = (await h.vault(account, 'Small')).vaultId
    const author = await device('author', small)
    for (let i = 1; i <= 6; i++) {
      await author.write('Note.md', `draft ${i}\n`)
      await author.sync()
    }
    await author.write('Gone.md', 'here today\n')
    await author.sync()
    await author.rm('Gone.md')
    await author.sync()
    // The engine pulls again after every push, so its cursor never trails its own commit.
    await author.sync()
    expect(await author.cursor()).toBe(8)

    const inject = vi.spyOn(h.app, 'inject')
    const newcomer = await device('newcomer', small)
    expect((await newcomer.sync()).push.committed).toBeNull()
    expect(urlsOf(inject, '/manifest')).toHaveLength(1)
    expect(urlsOf(inject, '/changes')).toEqual([`/v1/vaults/${small}/changes?since=8&limit=1000`])
    inject.mockRestore()
    expect(newcomer.stats).toEqual({ blobPuts: 0, blobHeads: 0, blobGets: 1, commits: 0 })
    expect(await newcomer.cursor()).toBe(8)
    expect(newcomer.paths()).toEqual(['Note.md'])
    expect(await newcomer.text('Note.md')).toBe('draft 6\n')
    expect(await newcomer.state.get('Note.md')).toEqual(await author.state.get('Note.md'))
  })

  it('a rename with an edit on top goes out as a move and a modify, keeping the history', async () => {
    const own = (await h.vault(account, 'Own')).vaultId
    const editor = await device('editor', own)
    await editor.write('A.md', 'first\nsecond\nthird\n')
    await editor.sync()
    const fileId = (await editor.state.get('A.md'))?.fileId

    // Most of the note's lines survive the edit, which is what makes it the same note.
    await editor.mv('A.md', 'B.md')
    await editor.write('B.md', 'first\nsecond\nthird\nedited after the rename\n')
    const pushed = (await editor.sync()).push.committed
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'applied', file_id: fileId, path: 'B.md' }),
      expect.objectContaining({ status: 'applied', file_id: fileId, path: 'B.md' }),
    ])
    expect(await editor.state.get('B.md')).toMatchObject({
      fileId,
      sha: await shaOf('first\nsecond\nthird\nedited after the rename\n'),
    })
    expect(await editor.state.get('A.md')).toBeNull()

    const reader = await device('reader', own)
    const observer = h.clientFor((await h.device(account, own)).deviceToken, own)
    const versions = await observer.versions(fileId ?? '')
    expect(versions.map((x) => [x.op, x.path])).toEqual([
      ['modify', 'B.md'],
      ['move', 'B.md'],
      ['create', 'A.md'],
    ])
    await converge(editor, reader)
    expect(reader.paths()).toEqual(['B.md'])
    expect(await reader.text('B.md')).toBe('first\nsecond\nthird\nedited after the rename\n')
  })
})

/** How many files the state knows. */
async function entries(d: Device): Promise<number> {
  let n = 0
  for await (const _ of d.state.all()) n++
  return n
}

/**
 * Every call a sync makes on the device's state and disk, by name. Walks of the whole state
 * or disk are counted by call (`state.all`, `fs.list`); everything else is a point operation.
 */
function counting(d: Device): Map<string, number> {
  const calls = new Map<string, number>()
  const bump = (name: string): void => {
    calls.set(name, (calls.get(name) ?? 0) + 1)
  }
  const watch = (target: object, methods: string[], prefix: string): void => {
    const on = target as Record<string, (...args: unknown[]) => unknown>
    for (const method of methods) {
      const found = on[method]
      if (found === undefined) throw new Error(`${prefix} has no ${method}`)
      const original = found.bind(target)
      on[method] = (...args: unknown[]) => {
        bump(`${prefix}.${method}`)
        return original(...args)
      }
    }
  }
  watch(d.state, ['all', 'get', 'byFileId', 'put', 'delete', 'transaction'], 'state')
  watch(d.fs, ['list', 'read', 'stat', 'writeAtomic', 'move', 'remove'], 'fs')
  return calls
}

/**
 * The work of a sync that placed `files` files grows with them and no faster: the whole
 * state and the whole disk are walked a fixed handful of times, however many files there
 * are, and each file costs a few point operations. A walk per file, or a lookup that scans,
 * is the quadratic this catches; the wall clock under load cannot tell it from a busy machine.
 */
function expectLinear(calls: Map<string, number>, files: number): void {
  const walks = Object.fromEntries(['state.all', 'fs.list'].map((k) => [k, calls.get(k) ?? 0]))
  expect(walks['state.all']).toBeLessThanOrEqual(12)
  expect(walks['fs.list']).toBeLessThanOrEqual(4)
  for (const [name, n] of calls) {
    if (name in walks) continue
    // Only stat grew: a pulled target is checked both before and after fetching.
    const perFile: Record<string, number> = {
      'state.get': 5,
      'state.byFileId': 5,
      'state.put': 5,
      'state.delete': 5,
      'state.transaction': 5,
      'fs.read': 5,
      'fs.stat': 7,
      'fs.writeAtomic': 5,
      'fs.move': 5,
      'fs.remove': 5,
    }
    expect(perFile[name], `unbudgeted operation ${name}`).toBeDefined()
    expect(n, `${name} over ${files} files`).toBeLessThanOrEqual(perFile[name]! * files)
  }
}
