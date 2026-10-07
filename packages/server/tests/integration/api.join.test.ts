import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
import { create, putBlob as put, commit as post, shaOf } from '../helpers/ops.js'

/**
 * `create.prefer` through the route: a device joining a vault it already
 * has files for sends its creates with the side the person chose. Whichever side wins, the
 * other is a version of the same file, and a create sent again changes nothing.
 */

let t: TestApp, laptop: string, joiner: string, v: string

const putBlob = (token: string, text: string | Buffer) => put(t.app, token, text)
const commit = (token: string, ops: unknown[]) => post(t.app, token, v, ops)
const history = async (fileId: string): Promise<Array<[string, string, number]>> =>
  (await api(t.app, laptop).get(`/v1/vaults/${v}/files/${fileId}/versions`)).body.map((x: any) => [
    x.op,
    x.sha,
    x.mtime,
  ])
const headOf = async (path: string): Promise<any> =>
  (await api(t.app, laptop).get(`/v1/vaults/${v}/manifest`)).body.items.find(
    (i: any) => i.path === path
  )

beforeAll(async () => {
  t = await buildTestApp()
  const { accountToken } = await t.account()
  v = (await t.vault(accountToken)).vaultId
  laptop = (await t.device(accountToken, v, 'laptop')).deviceToken
  joiner = (await t.device(accountToken, v, 'joiner')).deviceToken
})
afterAll(async () => {
  await t.close()
})

/** A file the laptop put there, and the joiner's own bytes for the same path, uploaded. */
async function race(path: string, theirs: string, mine: string, mtimes: [number, number]) {
  await putBlob(laptop, theirs)
  const seeded = await commit(laptop, [create(path, theirs, mtimes[0])])
  await putBlob(joiner, mine)
  return { fileId: seeded.results[0].file_id as string, op: create(path, mine, mtimes[1]) }
}

describe('create.prefer', () => {
  for (const [kind, path] of [
    ['a note', 'Both.md'],
    ['an attachment', 'both.png'],
    ['a settings file', '.obsidian/app.json'],
  ] as const) {
    it(`theirs on ${kind}: the head stays, the joiner's bytes are the version under it, even when newer`, async () => {
      const at = `theirs/${path}`.replace('theirs/.obsidian', '.obsidian')
      const theirs = `server ${kind}\n`
      const mine = `joiner ${kind}\n`
      const { fileId, op } = await race(at, theirs, mine, [10, 99])
      const r = await commit(joiner, [{ ...op, prefer: 'theirs' }])
      expect(r.results[0]).toMatchObject({
        status: 'merged',
        file_id: fileId,
        path: at,
        sha: shaOf(theirs),
      })
      expect(await history(fileId)).toEqual([
        ['merge', shaOf(theirs), 10],
        ['modify', shaOf(mine), 99],
        ['create', shaOf(theirs), 10],
      ])
      expect((await headOf(at)).sha).toBe(shaOf(theirs))

      // The same create again — a device that could not record the answer — writes nothing.
      const again = await commit(joiner, [{ ...op, prefer: 'theirs' }])
      expect(again.results[0]).toMatchObject({ status: 'merged', sha: shaOf(theirs) })
      expect(again.head_seq).toBe(r.head_seq)
      expect(await history(fileId)).toHaveLength(3)
      // Only after the settings file: the next test uses the same path for `mine`.
      if (at.startsWith('.obsidian')) {
        const head = await headOf(at)
        await commit(laptop, [{ op: 'delete', file_id: fileId, base_version_id: head.version_id }])
      }
    })

    it(`mine on ${kind}: the joiner's bytes are the head, the server's the version before, even when older`, async () => {
      const at = `mine/${path}`.replace('mine/.obsidian', '.obsidian')
      const theirs = `server ${kind} (2)\n`
      const mine = `joiner ${kind} (2)\n`
      const { fileId, op } = await race(at, theirs, mine, [99, 10])
      const r = await commit(joiner, [{ ...op, prefer: 'mine' }])
      expect(r.results[0]).toMatchObject({
        status: 'applied',
        file_id: fileId,
        path: at,
        sha: shaOf(mine),
      })
      expect(await history(fileId)).toEqual([
        ['modify', shaOf(mine), 10],
        ['create', shaOf(theirs), 99],
      ])
      expect((await headOf(at)).sha).toBe(shaOf(mine))
      const again = await commit(joiner, [{ ...op, prefer: 'mine' }])
      expect(again.results[0]).toMatchObject({ status: 'applied', sha: shaOf(mine) })
      expect(again.head_seq).toBe(r.head_seq)
    })
  }

  it('theirs finds the joiner’s bytes already kept by an earlier merge, and writes nothing again', async () => {
    // One device merged these bytes in, the note was cleaned back,
    // and a copy of that device's folder joins with theirs. Its text must be restorable as itself;
    // the merge kept it as a version of its own (engine fix 4), so theirs has nothing to add.
    const mine = 'a\nc\nlocal only para\n'
    const { fileId, op } = await race('Merged once.md', 'a\nb\n', mine, [10, 20])
    const merged = await commit(joiner, [op])
    expect(merged.results[0]).toMatchObject({ status: 'merged' })
    expect((await history(fileId)).map(([, sha]) => sha)).toContain(shaOf(mine))
    await putBlob(laptop, 'a\nb\n')
    const cleaned = await commit(laptop, [
      {
        ...create('Merged once.md', 'a\nb\n', 30),
        op: 'modify',
        file_id: fileId,
        base_version_id: merged.results[0].version_id,
      },
    ])

    const r = await commit(joiner, [{ ...op, prefer: 'theirs' }])
    expect(r.results[0]).toMatchObject({ status: 'merged', sha: shaOf('a\nb\n') })
    expect(r.head_seq).toBe(cleaned.head_seq)
    expect((await history(fileId)).filter(([, sha]) => sha === shaOf(mine))).toHaveLength(1)
  })

  it('names who did what under theirs: the joiner sent its bytes and caused the pick, the head is still the laptop’s', async () => {
    // Three-node run 2: the head of a joined file reads `merge` by the joiner while its bytes
    // are the server's. Each row names the device whose commit wrote it: the joiner's own bytes
    // (its sender), and the pick its create made happen. Whose bytes the pick kept is the row
    // it names as its head, which is the laptop's.
    const { fileId, op } = await race('Whose.md', 'server\n', 'joiner\n', [1, 2])
    await commit(joiner, [{ ...op, prefer: 'theirs' }])
    const rows = (await api(t.app, laptop).get(`/v1/vaults/${v}/files/${fileId}/versions`)).body
    expect(rows.map((x: any) => [x.op, x.actor.name])).toEqual([
      ['merge', 'joiner'],
      ['modify', 'joiner'],
      ['create', 'laptop'],
    ])
    expect(rows[0].merge.head_version_id).toBe(rows[2].version_id)
    expect(rows[0].merge.incoming_sha).toBe(rows[1].sha)
  })

  it('a note under theirs is picked, not merged, in a vault that copies conflicts aside', async () => {
    const r0 = await api(t.app, laptop).patch(`/v1/vaults/${v}/settings`, {
      conflict: 'conflict-file',
    })
    expect(r0.status).toBe(200)
    try {
      const { fileId, op } = await race('Copied.md', 'server\n', 'joiner\n', [1, 2])
      const r = await commit(joiner, [{ ...op, prefer: 'theirs' }])
      expect(r.results[0]).toMatchObject({ status: 'merged', sha: shaOf('server\n') })
      expect(r.results[0]).not.toHaveProperty('conflict_path')
      expect((await history(fileId)).map(([op, sha]) => [op, sha])).toEqual([
        ['merge', shaOf('server\n')],
        ['modify', shaOf('joiner\n')],
        ['create', shaOf('server\n')],
      ])
    } finally {
      await api(t.app, laptop).patch(`/v1/vaults/${v}/settings`, { conflict: 'merge' })
    }
  })

  it('a create with a preference onto a free path, or onto a path in the trash, is a new file', async () => {
    await putBlob(laptop, 'gone\n')
    const gone = await commit(laptop, [create('Gone.md', 'gone\n')])
    await commit(laptop, [
      {
        op: 'delete',
        file_id: gone.results[0].file_id,
        base_version_id: gone.results[0].version_id,
      },
    ])
    await putBlob(joiner, 'here\n')
    for (const prefer of ['mine', 'theirs'] as const) {
      const path = `${prefer}-free.md`
      const r = await commit(joiner, [{ ...create(path, 'here\n'), prefer }])
      expect(r.results[0]).toMatchObject({ status: 'applied', path })
    }
    const back = await commit(joiner, [{ ...create('Gone.md', 'here\n'), prefer: 'theirs' }])
    expect(back.results[0]).toMatchObject({ status: 'applied', path: 'Gone.md' })
    expect(back.results[0].file_id).not.toBe(gone.results[0].file_id)
    const trash = (await api(t.app, laptop).get(`/v1/vaults/${v}/trash`)).body
    expect(trash.map((i: any) => i.file_id)).toContain(gone.results[0].file_id)
  })
})
