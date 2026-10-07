import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
import { create, commit, putBlob, shaOf } from '../helpers/ops.js'
import { SimDevice, converge } from './sim.js'

let t: TestApp, account: string, v: string, laptop: SimDevice, phone: SimDevice

const sim = async (name: string, vaultId = v): Promise<SimDevice> => {
  const { deviceToken } = await t.device(account, vaultId, name)
  return new SimDevice(t.app, vaultId, deviceToken, name)
}

const listing = (d: SimDevice): Array<[string, string]> =>
  [...d.disk].map(([path, f]): [string, string] => [path, f.content.toString('hex')]).sort()

beforeAll(async () => {
  t = await buildTestApp()
  account = (await t.account()).accountToken
  v = (await t.vault(account)).vaultId
  laptop = await sim('laptop')
  phone = await sim('phone')
})
afterAll(async () => {
  await t.close()
})

describe('two devices', () => {
  const image = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(64)])

  it('laptop creates 3 notes and an image; phone syncs to an identical disk with 4 downloads', async () => {
    laptop.write('A.md', '# a\n')
    laptop.write('B.md', '# b\n')
    laptop.write('C.md', '# c\n')
    laptop.write('pic.png', image)
    const pushed = await laptop.sync()
    expect(pushed?.results.map((r) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ])
    expect(laptop.stats).toEqual({ blobPuts: 4, blobHeads: 4, blobGets: 0, commits: 1 })

    expect(await phone.sync()).toBeNull()
    expect(listing(phone)).toEqual(listing(laptop))
    expect(phone.stats.blobGets).toBe(4)
    expect(phone.cursor).toBe(4)
    expect(phone.state.get('pic.png')).toMatchObject({ sha: shaOf(image) })
  })

  it('phone edits a note and renames the image; laptop downloads the note, not the image', async () => {
    phone.write('A.md', '# a, edited on the phone\n')
    phone.mv('pic.png', 'img/pic.png')
    const pushed = await phone.sync()
    expect(pushed?.results.map((r) => [r.status, (r as { path?: string }).path])).toEqual([
      ['applied', 'img/pic.png'],
      ['applied', 'A.md'],
    ])

    const before = laptop.stats.blobGets
    await laptop.sync()
    expect(laptop.text('A.md')).toBe('# a, edited on the phone\n')
    expect(laptop.disk.has('pic.png')).toBe(false)
    expect(laptop.disk.get('img/pic.png')?.content.equals(image)).toBe(true)
    expect(laptop.stats.blobGets).toBe(before + 1)
    expect(listing(laptop)).toEqual(listing(phone))
  })

  it('laptop deletes a note; phone syncs and it is gone', async () => {
    laptop.rm('B.md')
    const pushed = await laptop.sync()
    expect(pushed?.results).toEqual([expect.objectContaining({ status: 'applied', path: 'B.md' })])
    await phone.sync()
    expect(phone.disk.has('B.md')).toBe(false)
    expect(phone.state.has('B.md')).toBe(false)
    expect(listing(phone)).toEqual(listing(laptop))
  })

  it('laptop writes the same note twice between syncs: one commit, one modify, the last content', async () => {
    const { head_seq: before } = (
      await api(t.app, (await t.device(account, v)).deviceToken).get(`/v1/vaults/${v}/state`)
    ).body
    const commits = laptop.stats.commits
    laptop.write('C.md', '# c, second draft\n')
    laptop.write('C.md', '# c, final\n')
    const pushed = await laptop.sync()
    expect(laptop.stats.commits).toBe(commits + 1)
    expect(pushed?.results).toEqual([expect.objectContaining({ status: 'applied', path: 'C.md' })])
    expect(pushed?.head_seq).toBe(before + 1)

    const feed = (
      await api(t.app, (await t.device(account, v)).deviceToken).get(
        `/v1/vaults/${v}/changes?since=${before}`
      )
    ).body
    expect(feed.items).toEqual([
      expect.objectContaining({ op: 'modify', path: 'C.md', sha: shaOf('# c, final\n') }),
    ])
    await phone.sync()
    expect(phone.text('C.md')).toBe('# c, final\n')
    await converge(laptop, phone)
  })

  it('a device that never synced bootstraps 1500 files from the paged manifest, then follows changes', async () => {
    const big = (await t.vault(account, 'Big')).vaultId
    const { deviceToken: seeder } = await t.device(account, big, 'seeder')
    const text = 'the same text in every note\n'
    await putBlob(t.app, seeder, text)
    const paths = Array.from({ length: 1500 }, (_, i) => `notes/${String(i).padStart(4, '0')}.md`)
    for (const batch of [paths.slice(0, 750), paths.slice(750)]) {
      const r = await commit(
        t.app,
        seeder,
        big,
        batch.map((p) => create(p, text))
      )
      expect(r.results.every((x: { status: string }) => x.status === 'applied')).toBe(true)
    }

    const inject = vi.spyOn(t.app, 'inject')
    const newcomer = await sim('newcomer', big)
    expect(await newcomer.sync()).toBeNull()
    // `inject` is overloaded; the spy types its calls from the arg-less form.
    const urls = inject.mock.calls.map((call) => ((call as unknown[])[0] as { url: string }).url)
    inject.mockRestore()
    expect(urls.filter((u) => u.includes('/manifest'))).toHaveLength(2)
    expect(urls.filter((u) => u.includes('/changes'))).toEqual([
      `/v1/vaults/${big}/changes?since=1500&limit=1000`,
    ])
    expect(newcomer.cursor).toBe(1500)
    expect(newcomer.disk.size).toBe(1500)
    expect(newcomer.state.size).toBe(1500)
    expect([...newcomer.disk.keys()].sort()).toEqual(paths)
    expect(newcomer.text('notes/1499.md')).toBe(text)
    // One blob behind 1500 files: fetched once, then found on the disk.
    expect(newcomer.stats).toEqual({ blobPuts: 0, blobHeads: 0, blobGets: 1, commits: 0 })

    // From here the feed: 1001 more files, one page and one item over.
    const more = Array.from({ length: 1001 }, (_, i) => `more/${String(i).padStart(4, '0')}.md`)
    await putBlob(t.app, seeder, 'one more\n')
    for (const batch of [more.slice(0, 1000), more.slice(1000)]) {
      await commit(
        t.app,
        seeder,
        big,
        batch.map((p) => create(p, 'one more\n'))
      )
    }
    const follow = vi.spyOn(t.app, 'inject')
    expect(await newcomer.sync()).toBeNull()
    const followed = follow.mock.calls.map(
      (call) => ((call as unknown[])[0] as { url: string }).url
    )
    follow.mockRestore()
    expect(followed.filter((u) => u.includes('/manifest'))).toHaveLength(0)
    expect(followed.filter((u) => u.includes('/changes'))).toEqual([
      `/v1/vaults/${big}/changes?since=1500&limit=1000`,
      `/v1/vaults/${big}/changes?since=2500&limit=1000`,
    ])
    expect(newcomer.cursor).toBe(2501)
    expect(newcomer.disk.size).toBe(2501)
    expect(newcomer.text('more/1000.md')).toBe('one more\n')
    expect(newcomer.stats.blobGets).toBe(2)
  })

  it('a device that never synced reads the manifest, not the history, however short it is', async () => {
    const small = (await t.vault(account, 'Small')).vaultId
    const author = await sim('author', small)
    for (let i = 1; i <= 6; i++) {
      author.write('Note.md', `draft ${i}\n`)
      await author.sync()
    }
    author.write('Gone.md', 'here today\n')
    await author.sync()
    author.rm('Gone.md')
    await author.sync()
    // A device's cursor trails its own commit until it pulls again.
    await author.sync()
    expect(author.cursor).toBe(8)

    const inject = vi.spyOn(t.app, 'inject')
    const newcomer = await sim('newcomer', small)
    expect(await newcomer.sync()).toBeNull()
    const urls = inject.mock.calls.map((call) => ((call as unknown[])[0] as { url: string }).url)
    inject.mockRestore()
    expect(urls.filter((u) => u.includes('/manifest'))).toHaveLength(1)
    expect(urls.filter((u) => u.includes('/changes'))).toEqual([
      `/v1/vaults/${small}/changes?since=8&limit=1000`,
    ])
    expect(newcomer.stats).toEqual({ blobPuts: 0, blobHeads: 0, blobGets: 1, commits: 0 })
    expect(newcomer.cursor).toBe(8)
    expect([...newcomer.disk.keys()]).toEqual(['Note.md'])
    expect(newcomer.text('Note.md')).toBe('draft 6\n')
    expect(newcomer.state.get('Note.md')).toEqual(author.state.get('Note.md'))
  })

  it('a rename with an edit on top goes out as a move and a modify, keeping the history', async () => {
    const own = (await t.vault(account, 'Own')).vaultId
    const editor = await sim('editor', own)
    editor.write('A.md', 'first\n')
    await editor.sync()
    const fileId = editor.state.get('A.md')?.fileId

    editor.mv('A.md', 'B.md')
    editor.write('B.md', 'edited after the rename\n')
    const pushed = await editor.sync()
    expect(pushed?.results).toEqual([
      expect.objectContaining({ status: 'applied', file_id: fileId, path: 'B.md' }),
      expect.objectContaining({ status: 'applied', file_id: fileId, path: 'B.md' }),
    ])
    expect(editor.state.get('B.md')).toMatchObject({
      fileId,
      sha: shaOf('edited after the rename\n'),
    })
    expect(editor.state.has('A.md')).toBe(false)

    const reader = await sim('reader', own)
    const versions = (
      await api(t.app, (await t.device(account, own)).deviceToken).get(
        `/v1/vaults/${own}/files/${fileId}/versions`
      )
    ).body as Array<{ op: string; path: string }>
    expect(versions.map((x) => [x.op, x.path])).toEqual([
      ['modify', 'B.md'],
      ['move', 'B.md'],
      ['create', 'A.md'],
    ])
    await converge(editor, reader)
    expect([...reader.disk.keys()]).toEqual(['B.md'])
    expect(reader.text('B.md')).toBe('edited after the rename\n')
  })
})
