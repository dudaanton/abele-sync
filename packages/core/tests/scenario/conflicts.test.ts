import { randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge, nextMtime } from '../helpers/device.js'
import { setConflictMode, shaOf } from '../helpers/seed.js'

let h: Harness, account: string

/** A fresh vault in the given conflict mode, with a laptop and a phone that both hold `files`. */
async function pair(
  mode: 'merge' | 'conflict-file',
  files: Record<string, string | Buffer> = {}
): Promise<{ laptop: Device; phone: Device; vaultId: string; token: string }> {
  const { vaultId } = await h.vault(account, mode)
  const device = async (name: string): Promise<Device> => {
    const { deviceToken } = await h.device(account, vaultId, name)
    return new Device(h, vaultId, deviceToken, name)
  }
  const laptop = await device('laptop')
  const phone = await device('phone')
  const token = (await h.device(account, vaultId, 'observer')).deviceToken
  if (mode === 'conflict-file') await setConflictMode(h, token, vaultId, mode)
  for (const [path, content] of Object.entries(files)) await laptop.write(path, content)
  if (Object.keys(files).length > 0) {
    await laptop.sync()
    await phone.sync()
  }
  return { laptop, phone, vaultId, token }
}

const paths = (d: Device): string[] => d.paths()

const conflictCopy = (d: Device, stem: string): string | undefined =>
  paths(d).find((p) => new RegExp(`^${stem} \\(Conflicted copy phone \\d{12}\\)\\.md$`).test(p))

/** The first result of what a sync committed. */
const verdict = async (d: Device) => (await d.sync()).push.committed?.results[0]

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

describe('conflicts: spec §6, one row at a time', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\n'

  it('note, disjoint edits on both: both converge on the merged text; the second committer got merged', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await laptop.write('Note.md', 'ONE\ntwo\nthree\nfour\nfive\n')
    await phone.write('Note.md', 'one\ntwo\nthree\nfour\nFIVE\n')
    expect(await verdict(laptop)).toMatchObject({ status: 'applied' })
    expect(await verdict(phone)).toMatchObject({ status: 'merged', path: 'Note.md' })
    expect(await phone.text('Note.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
    await converge(laptop, phone)
    expect(await laptop.text('Note.md')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n')
  })

  it('note, overlapping edits, merge mode: both lines survive, head first', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await laptop.write('Note.md', 'one\nTWO by laptop\nthree\nfour\nfive\n')
    await phone.write('Note.md', 'one\nTWO by phone\nthree\nfour\nfive\n')
    await laptop.sync()
    expect(await verdict(phone)).toMatchObject({ status: 'merged' })
    await converge(laptop, phone)
    const text = (await laptop.text('Note.md')) ?? ''
    expect(text).toBe('one\nTWO by laptop\nTWO by phone\nthree\nfour\nfive\n')
    expect(text.indexOf('by laptop')).toBeLessThan(text.indexOf('by phone'))
    expect(paths(laptop)).toEqual(['Note.md'])
  })

  it('note, overlapping edits, conflict-file mode: the original keeps the first committer, the copy holds the second', async () => {
    const { laptop, phone } = await pair('conflict-file', { 'Note.md': base })
    const fromLaptop = 'one\nTWO by laptop\nthree\nfour\nfive\n'
    const fromPhone = 'one\nTWO by phone\nthree\nfour\nfive\n'
    await laptop.write('Note.md', fromLaptop)
    await phone.write('Note.md', fromPhone)
    await laptop.sync()
    expect(await verdict(phone)).toMatchObject({
      status: 'conflict',
      path: 'Note.md',
      conflict_path: expect.stringMatching(/^Note \(Conflicted copy phone \d{12}\)\.md$/),
    })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(await d.text('Note.md')).toBe(fromLaptop)
      const copy = conflictCopy(d, 'Note')
      expect(copy).toBeDefined()
      expect(await d.text(copy ?? '')).toBe(fromPhone)
      expect(paths(d)).toHaveLength(2)
    }
  })

  it('attachment edited on both: the newer mtime wins on both; the older is kept in history', async () => {
    const seed = randomBytes(32)
    const { laptop, phone, vaultId, token } = await pair('merge', { 'pic.bin': seed })
    const older = randomBytes(32)
    const newer = randomBytes(32)
    await phone.write('pic.bin', older)
    await laptop.write('pic.bin', newer)
    expect((await laptop.fs.stat('pic.bin'))!.mtime).toBeGreaterThan(
      (await phone.fs.stat('pic.bin'))!.mtime
    )
    await laptop.sync()
    expect(await verdict(phone)).toMatchObject({ status: 'merged', path: 'pic.bin' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) expect(await d.holds('pic.bin', newer)).toBe(true)

    const fileId = (await laptop.state.get('pic.bin'))?.fileId
    const versions = await h.clientFor(token, vaultId).versions(fileId ?? '')
    expect(versions.map((x) => [x.op, x.sha])).toEqual([
      ['merge', await shaOf(newer)],
      ['modify', await shaOf(older)],
      ['modify', await shaOf(newer)],
      ['create', await shaOf(seed)],
    ])
  })

  it('attachment edited on both, the newer arriving second: it is applied over the head', async () => {
    const { laptop, phone } = await pair('merge', { 'pic.bin': randomBytes(32) })
    const older = randomBytes(32)
    const newer = randomBytes(32)
    await laptop.write('pic.bin', older)
    await phone.write('pic.bin', newer)
    await laptop.sync()
    expect(await verdict(phone)).toMatchObject({ status: 'applied', path: 'pic.bin' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) expect(await d.holds('pic.bin', newer)).toBe(true)
  })

  describe('create vs create at one path', () => {
    it('note in merge mode: both texts, head first', async () => {
      const { laptop, phone } = await pair('merge')
      await laptop.write('New.md', 'from laptop\n')
      await phone.write('New.md', 'from phone\n')
      await laptop.sync()
      expect(await verdict(phone)).toMatchObject({ status: 'merged', path: 'New.md' })
      await converge(laptop, phone)
      expect(await laptop.text('New.md')).toBe('from laptop\nfrom phone\n')
      expect(paths(laptop)).toEqual(['New.md'])
    })

    it('note in conflict-file mode: the second becomes a conflicted copy', async () => {
      const { laptop, phone } = await pair('conflict-file')
      await laptop.write('New.md', 'from laptop\n')
      await phone.write('New.md', 'from phone\n')
      await laptop.sync()
      expect(await verdict(phone)).toMatchObject({ status: 'conflict', path: 'New.md' })
      await converge(laptop, phone)
      for (const d of [laptop, phone]) {
        expect(await d.text('New.md')).toBe('from laptop\n')
        expect(await d.text(conflictCopy(d, 'New') ?? '')).toBe('from phone\n')
        expect(paths(d)).toHaveLength(2)
      }
    })

    it('attachment: the newer mtime wins', async () => {
      const { laptop, phone } = await pair('merge')
      const older = randomBytes(32)
      const newer = randomBytes(32)
      await laptop.write('a.bin', older)
      await phone.write('a.bin', newer)
      await laptop.sync()
      expect(await verdict(phone)).toMatchObject({ status: 'applied', path: 'a.bin' })
      await converge(laptop, phone)
      for (const d of [laptop, phone]) expect(await d.holds('a.bin', newer)).toBe(true)
      expect(paths(laptop)).toEqual(['a.bin'])
    })

    it('identical bytes on both: applied as a noop, nothing uploaded twice', async () => {
      const { laptop, phone } = await pair('merge')
      await laptop.write('Same.md', 'same\n')
      await phone.write('Same.md', 'same\n')
      await laptop.sync()
      expect((await phone.sync()).push.committed).toBeNull()
      expect(phone.stats).toEqual({ blobPuts: 0, blobHeads: 0, blobGets: 0, commits: 0 })
      expect((await phone.state.get('Same.md'))?.fileId).toBe(
        (await laptop.state.get('Same.md'))?.fileId
      )
      await converge(laptop, phone)
    })
  })

  it('modify vs delete: the file is back on both devices with the modification', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await laptop.rm('Note.md')
    await laptop.sync()
    expect(laptop.has('Note.md')).toBe(false)
    await phone.write('Note.md', 'edited after the delete\n')
    expect(await verdict(phone)).toMatchObject({ status: 'applied', path: 'Note.md' })
    await converge(laptop, phone)
    expect(await laptop.text('Note.md')).toBe('edited after the delete\n')
    expect(await phone.text('Note.md')).toBe('edited after the delete\n')
  })

  it('delete vs modify: the change outlives the delete on the device that deleted', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await laptop.write('Note.md', 'edited before the delete\n')
    await laptop.sync()
    await phone.rm('Note.md')
    expect(await verdict(phone)).toMatchObject({ status: 'merged', path: 'Note.md' })
    await converge(laptop, phone)
    expect(await phone.text('Note.md')).toBe('edited before the delete\n')
  })

  it('delete and recreate vs modify: the new file takes the path, the edit comes back beside it', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    const oldId = (await phone.state.get('Note.md'))?.fileId
    await laptop.rm('Note.md')
    await laptop.sync()
    await laptop.write('Note.md', 'a new note under the old name\n')
    await laptop.sync()
    const newId = (await laptop.state.get('Note.md'))?.fileId
    expect(newId).not.toBe(oldId)

    await phone.write('Note.md', 'the old note, edited on the phone\n')
    expect((await phone.sync()).push.committed?.results).toEqual([
      expect.objectContaining({ status: 'applied', file_id: oldId, path: 'Note 1.md' }),
    ])
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Note 1.md', 'Note.md'])
      expect(await d.text('Note.md')).toBe('a new note under the old name\n')
      expect(await d.text('Note 1.md')).toBe('the old note, edited on the phone\n')
      expect((await d.state.get('Note.md'))?.fileId).toBe(newId)
      expect((await d.state.get('Note 1.md'))?.fileId).toBe(oldId)
    }
  })

  it('move onto a path vs a new file there, merge mode: the texts merge, the id is the moved file’s', async () => {
    const { laptop, phone } = await pair('merge', { 'A.md': 'from A\n' })
    const movedId = (await laptop.state.get('A.md'))?.fileId
    await laptop.mv('A.md', 'B.md')
    await laptop.sync()
    await phone.write('B.md', 'a new B on the phone\n')
    expect((await phone.sync()).push.committed?.results).toEqual([
      expect.objectContaining({ status: 'merged', file_id: movedId, path: 'B.md' }),
    ])
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['B.md'])
      expect(await d.text('B.md')).toBe('from A\na new B on the phone\n')
      expect((await d.state.get('B.md'))?.fileId).toBe(movedId)
    }
  })

  it('move onto a path vs a new file there, conflict-file mode: the new file becomes the copy', async () => {
    const { laptop, phone } = await pair('conflict-file', { 'A.md': 'from A\n' })
    await laptop.mv('A.md', 'B.md')
    await laptop.sync()
    await phone.write('B.md', 'a new B on the phone\n')
    expect(await verdict(phone)).toMatchObject({ status: 'conflict', path: 'B.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(await d.text('B.md')).toBe('from A\n')
      expect(await d.text(conflictCopy(d, 'B') ?? '')).toBe('a new B on the phone\n')
      expect(paths(d)).toHaveLength(2)
    }
  })

  it('move vs modify: both devices end with the new path and the new content', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await laptop.mv('Note.md', 'Moved.md')
    await laptop.sync()
    await phone.write('Note.md', 'edited on the phone\n')
    expect(await verdict(phone)).toMatchObject({ status: 'applied', path: 'Moved.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Moved.md'])
      expect(await d.text('Moved.md')).toBe('edited on the phone\n')
    }
  })

  it('modify vs move: the move carries the modification with it', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await phone.write('Note.md', 'edited on the phone\n')
    await phone.sync()
    await laptop.mv('Note.md', 'Moved.md')
    expect(await verdict(laptop)).toMatchObject({ status: 'applied', path: 'Moved.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Moved.md'])
      expect(await d.text('Moved.md')).toBe('edited on the phone\n')
    }
  })

  it('move vs move: both end with the first committer’s path; the second was rejected path_taken', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': base })
    await laptop.mv('Note.md', 'Laptop.md')
    await laptop.sync()
    await phone.mv('Note.md', 'Phone.md')
    const report = await phone.sync()
    expect(report.push.committed?.results[0]).toMatchObject({
      status: 'rejected',
      code: 'path_taken',
    })
    // The refused rename went back where it was, so nothing about it is left for the next scan,
    // and the pull after the push is free to put the file where the winner did — this sync.
    expect(report.secondPull?.applied).toBe(1)
    expect(phone.paths()).toEqual(['Laptop.md'])
    expect(phone.engine.status.pending).toBe(0)
    expect(phone.rejected).toEqual([
      expect.objectContaining({
        op: expect.objectContaining({ op: 'move', to_path: 'Phone.md' }),
        code: 'path_taken',
      }),
    ])
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(paths(d)).toEqual(['Laptop.md'])
      expect(await d.text('Laptop.md')).toBe(base)
    }
    expect(phone.rejected).toHaveLength(1)
  })

  it('a merge that would break the frontmatter becomes a conflict copy even in merge mode', async () => {
    const { laptop, phone } = await pair('merge', { 'Note.md': '---\na: 1\n---\nbody\n' })
    const fromLaptop = '---\na: [1\n---\nbody\n'
    const fromPhone = '---\na: 2]\n---\nbody\n'
    await laptop.write('Note.md', fromLaptop)
    await phone.write('Note.md', fromPhone)
    await laptop.sync()
    expect(await verdict(phone)).toMatchObject({ status: 'conflict', path: 'Note.md' })
    await converge(laptop, phone)
    for (const d of [laptop, phone]) {
      expect(await d.text('Note.md')).toBe(fromLaptop)
      expect(await d.text(conflictCopy(d, 'Note') ?? '')).toBe(fromPhone)
      expect(paths(d)).toHaveLength(2)
    }
  })

  it('mtimes from the shared clock only ever go up', () => {
    const a = nextMtime()
    expect(nextMtime()).toBeGreaterThan(a)
  })
})
