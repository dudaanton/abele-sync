import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { VersionInfo } from '@abele/sync-protocol'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
import { shaOf } from '../helpers/ops.js'
import { SimDevice, converge, nextMtime } from './sim.js'

let t: TestApp, account: string

/** A fresh vault in the given conflict mode, with a laptop and a phone that both hold `files`. */
async function pair(
  mode: 'merge' | 'conflict-file',
  files: Record<string, string | Buffer> = {}
): Promise<{ laptop: SimDevice; phone: SimDevice; vaultId: string; token: string }> {
  const { vaultId } = await t.vault(account, mode)
  const sim = async (name: string): Promise<SimDevice> => {
    const { deviceToken } = await t.device(account, vaultId, name)
    return new SimDevice(t.app, vaultId, deviceToken, name)
  }
  const laptop = await sim('laptop')
  const phone = await sim('phone')
  const token = (await t.device(account, vaultId, 'observer')).deviceToken
  if (mode === 'conflict-file') {
    const r = await api(t.app, token).patch(`/v1/vaults/${vaultId}/settings`, { conflict: mode })
    expect(r.status).toBe(200)
  }
  for (const [path, content] of Object.entries(files)) laptop.write(path, content)
  if (Object.keys(files).length > 0) {
    await laptop.sync()
    await phone.sync()
  }
  return { laptop, phone, vaultId, token }
}

const paths = (d: SimDevice): string[] => [...d.disk.keys()].sort()

const conflictCopy = (d: SimDevice, stem: string): string | undefined =>
  paths(d).find((p) => new RegExp(`^${stem} \\(Conflicted copy phone \\d{12}\\)\\.md$`).test(p))

beforeAll(async () => {
  t = await buildTestApp()
  account = (await t.account()).accountToken
})
afterAll(async () => {
  await t.close()
})

describe('conflicts: spec §6, one row at a time', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n'

  it('note, disjoint edits on both: both converge on the merged text; the second committer got merged', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    laptop.write('Note.md', 'ONE\ntwo\nthree\nfour\nfive\n')
    phone.write('Note.md', 'one\ntwo\nthree\nfour\nFIVE\n')
    expect((await laptop.sync())?.results[0]).toMatchObject({ status: 'applied' })
    const second = await phone.sync()
    expect(second?.results[0]).toMatchObject({ status: 'merged', path: 'Note.md' })
    expect(phone.text('Note.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
    await converge(laptop, phone)
    expect(laptop.text('Note.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
  })

  it('note, overlapping edits, merge mode: both lines survive, head first', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    laptop.write('Note.md', 'one\nTWO by laptop\nthree\nfour\nfive\n')
    phone.write('Note.md', 'one\nTWO by phone\nthree\nfour\nfive\n')
    await laptop.sync()
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'merged' })
    await converge(laptop, phone)
    const text = laptop.text('Note.md') ?? ''
    expect(text).toBe('one\nTWO by laptop\nTWO by phone\nthree\nfour\nfive\n')
    expect(text.indexOf('by laptop')).toBeLessThan(text.indexOf('by phone'))
    expect(paths(laptop)).toEqual(['Note.md'])
  })

  it('note, overlapping edits, conflict-file mode: the original keeps the first committer, the copy holds the second', async () => {
    const { laptop, phone } = await pair('conflict-file', { 'Note.md': base })
    const fromLaptop = 'one\nTWO by laptop\nthree\nfour\nfive\n'
    const fromPhone = 'one\nTWO by phone\nthree\nfour\nfive\n'
    laptop.write('Note.md', fromLaptop)
    phone.write('Note.md', fromPhone)
    await laptop.sync()
    const second = await phone.sync()
    expect(second?.results[0]).toMatchObject({
      status: 'conflict',
      path: 'Note.md',
      conflict_path: expect.stringMatching(/^Note \(Conflicted copy phone \d{12}\)\.md$/),
    })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(d.text('Note.md')).toBe(fromLaptop)
      const copy = conflictCopy(d, 'Note')
      expect(copy).toBeDefined()
      expect(d.text(copy ?? '')).toBe(fromPhone)
      expect(paths(d)).toHaveLength(2)
    }
  })

  it('attachment edited on both: the newer mtime wins on both; the older is kept in history', async () => {
    const seed = randomBytes(32)
    const { laptop, phone, vaultId, token } = await pair('merge', { 'pic.bin': seed })
    const older = randomBytes(32)
    const newer = randomBytes(32)
    phone.write('pic.bin', older)
    laptop.write('pic.bin', newer)
    expect(laptop.disk.get('pic.bin')!.mtime).toBeGreaterThan(phone.disk.get('pic.bin')!.mtime)
    await laptop.sync()
    const second = await phone.sync()
    expect(second?.results[0]).toMatchObject({ status: 'merged', path: 'pic.bin' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) expect(d.disk.get('pic.bin')?.content.equals(newer)).toBe(true)

    const fileId = laptop.state.get('pic.bin')?.fileId
    const versions = (await api(t.app, token).get(`/v1/vaults/${vaultId}/files/${fileId}/versions`))
      .body as VersionInfo[]
    expect(versions.map((x) => [x.op, x.sha])).toEqual([
      ['merge', shaOf(newer)],
      ['modify', shaOf(older)],
      ['modify', shaOf(newer)],
      ['create', shaOf(seed)],
    ])
  })

  it('attachment edited on both, the newer arriving second: it is applied over the head', async () => {
    const { laptop, phone } = await pair('merge', { 'pic.bin': randomBytes(32) })
    const older = randomBytes(32)
    const newer = randomBytes(32)
    laptop.write('pic.bin', older)
    phone.write('pic.bin', newer)
    await laptop.sync()
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'applied', path: 'pic.bin' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) expect(d.disk.get('pic.bin')?.content.equals(newer)).toBe(true)
  })

  describe('create vs create at one path', () => {
    it('note in merge mode: both texts, head first', async () => {
      const { laptop, phone } = await pair('merge')
      laptop.write('New.md', 'from laptop\n')
      phone.write('New.md', 'from phone\n')
      await laptop.sync()
      expect((await phone.sync())?.results[0]).toMatchObject({ status: 'merged', path: 'New.md' })
      await converge(laptop, phone)
      expect(laptop.text('New.md')).toBe('from laptop\nfrom phone\n')
      expect(paths(laptop)).toEqual(['New.md'])
    })

    it('note in conflict-file mode: the second becomes a conflicted copy', async () => {
      const { laptop, phone } = await pair('conflict-file')
      laptop.write('New.md', 'from laptop\n')
      phone.write('New.md', 'from phone\n')
      await laptop.sync()
      expect((await phone.sync())?.results[0]).toMatchObject({ status: 'conflict', path: 'New.md' })
      await converge(laptop, phone)
      for (const d of [laptop, phone]) {
        expect(d.text('New.md')).toBe('from laptop\n')
        expect(d.text(conflictCopy(d, 'New') ?? '')).toBe('from phone\n')
        expect(paths(d)).toHaveLength(2)
      }
    })

    it('attachment: the newer mtime wins', async () => {
      const { laptop, phone } = await pair('merge')
      const older = randomBytes(32)
      const newer = randomBytes(32)
      laptop.write('a.bin', older)
      phone.write('a.bin', newer)
      await laptop.sync()
      expect((await phone.sync())?.results[0]).toMatchObject({ status: 'applied', path: 'a.bin' })
      await converge(laptop, phone)
      for (const d of [laptop, phone]) expect(d.disk.get('a.bin')?.content.equals(newer)).toBe(true)
      expect(paths(laptop)).toEqual(['a.bin'])
    })

    it('identical bytes on both: applied as a noop, nothing uploaded twice', async () => {
      const { laptop, phone } = await pair('merge')
      laptop.write('Same.md', 'same\n')
      phone.write('Same.md', 'same\n')
      await laptop.sync()
      expect(await phone.sync()).toBeNull()
      expect(phone.stats).toEqual({ blobPuts: 0, blobHeads: 0, blobGets: 0, commits: 0 })
      expect(phone.state.get('Same.md')?.fileId).toBe(laptop.state.get('Same.md')?.fileId)
      await converge(laptop, phone)
    })
  })

  it('modify vs delete: the file is back on both devices with the modification', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    laptop.rm('Note.md')
    await laptop.sync()
    expect(laptop.disk.has('Note.md')).toBe(false)
    phone.write('Note.md', 'edited after the delete\n')
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'applied', path: 'Note.md' })
    await converge(laptop, phone)
    expect(laptop.text('Note.md')).toBe('edited after the delete\n')
    expect(phone.text('Note.md')).toBe('edited after the delete\n')
  })

  it('delete vs modify: the change outlives the delete on the device that deleted', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    laptop.write('Note.md', 'edited before the delete\n')
    await laptop.sync()
    phone.rm('Note.md')
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'merged', path: 'Note.md' })
    await converge(laptop, phone)
    expect(phone.text('Note.md')).toBe('edited before the delete\n')
  })

  it('delete and recreate vs modify: the new file takes the path, the edit comes back beside it', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    const oldId = phone.state.get('Note.md')?.fileId
    laptop.rm('Note.md')
    await laptop.sync()
    laptop.write('Note.md', 'a new note under the old name\n')
    await laptop.sync()
    const newId = laptop.state.get('Note.md')?.fileId
    expect(newId).not.toBe(oldId)

    phone.write('Note.md', 'the old note, edited on the phone\n')
    expect((await phone.sync())?.results).toEqual([
      expect.objectContaining({ status: 'applied', file_id: oldId, path: 'Note 1.md' }),
    ])
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Note 1.md', 'Note.md'])
      expect(d.text('Note.md')).toBe('a new note under the old name\n')
      expect(d.text('Note 1.md')).toBe('the old note, edited on the phone\n')
      expect(d.state.get('Note.md')?.fileId).toBe(newId)
      expect(d.state.get('Note 1.md')?.fileId).toBe(oldId)
    }
  })

  it('move onto a path vs a new file there, merge mode: the texts merge, the id is the moved file’s', async () => {
    const { laptop, phone } = await pair('merge', { 'A.md': 'from A\n' })
    const movedId = laptop.state.get('A.md')?.fileId
    laptop.mv('A.md', 'B.md')
    await laptop.sync()
    phone.write('B.md', 'a new B on the phone\n')
    expect((await phone.sync())?.results).toEqual([
      expect.objectContaining({ status: 'merged', file_id: movedId, path: 'B.md' }),
    ])
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['B.md'])
      expect(d.text('B.md')).toBe('from A\na new B on the phone\n')
      expect(d.state.get('B.md')?.fileId).toBe(movedId)
    }
  })

  it('move onto a path vs a new file there, conflict-file mode: the new file becomes the copy', async () => {
    const { laptop, phone } = await pair('conflict-file', { 'A.md': 'from A\n' })
    laptop.mv('A.md', 'B.md')
    await laptop.sync()
    phone.write('B.md', 'a new B on the phone\n')
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'conflict', path: 'B.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(d.text('B.md')).toBe('from A\n')
      expect(d.text(conflictCopy(d, 'B') ?? '')).toBe('a new B on the phone\n')
      expect(paths(d)).toHaveLength(2)
    }
  })

  it('move vs modify: both devices end with the new path and the new content', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    laptop.mv('Note.md', 'Moved.md')
    await laptop.sync()
    phone.write('Note.md', 'edited on the phone\n')
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'applied', path: 'Moved.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Moved.md'])
      expect(d.text('Moved.md')).toBe('edited on the phone\n')
    }
  })

  it('modify vs move: the move carries the modification with it', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    phone.write('Note.md', 'edited on the phone\n')
    await phone.sync()
    laptop.mv('Note.md', 'Moved.md')
    expect((await laptop.sync())?.results[0]).toMatchObject({ status: 'applied', path: 'Moved.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Moved.md'])
      expect(d.text('Moved.md')).toBe('edited on the phone\n')
    }
  })

  it('move vs move: both end with the first committer’s path; the second was rejected path_taken', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    laptop.mv('Note.md', 'Laptop.md')
    await laptop.sync()
    phone.mv('Note.md', 'Phone.md')
    expect((await phone.sync())?.results[0]).toMatchObject({
      status: 'rejected',
      code: 'path_taken',
    })
    expect(phone.rejected).toEqual([
      { op: expect.objectContaining({ op: 'move', to_path: 'Phone.md' }), code: 'path_taken' },
    ])
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Laptop.md'])
      expect(d.text('Laptop.md')).toBe(base)
    }
    expect(phone.rejected).toHaveLength(1)
  })

  it('a merge that would break the frontmatter becomes a conflict copy even in merge mode', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': '---\na: 1\n---\nbody\n' })
    const fromLaptop = '---\na: [1\n---\nbody\n'
    const fromPhone = '---\na: 2]\n---\nbody\n'
    laptop.write('Note.md', fromLaptop)
    phone.write('Note.md', fromPhone)
    await laptop.sync()
    expect((await phone.sync())?.results[0]).toMatchObject({ status: 'conflict', path: 'Note.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(d.text('Note.md')).toBe(fromLaptop)
      expect(d.text(conflictCopy(d, 'Note') ?? '')).toBe(fromPhone)
      expect(paths(d)).toHaveLength(2)
    }
  })

  it('mtimes from the shared clock only ever go up', () => {
    const a = nextMtime()
    expect(nextMtime()).toBeGreaterThan(a)
  })
})
