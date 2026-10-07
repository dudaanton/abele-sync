import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import {
  ChangesResponseSchema,
  CommitResponseSchema,
  ManifestResponseSchema,
} from '@abele/sync-protocol'
import { manifest } from '../../src/oplog/changes.js'
import { commit as commitDirect } from '../../src/oplog/commit.js'
import { EventHub } from '../../src/events/hub.js'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
import { create, octet, putBlob as put, commit as post, shaOf } from '../helpers/ops.js'

let t: TestApp, tok: string, tok2: string, v: string

const putBlob = (token: string, text: string | Buffer) => put(t.app, token, text)
const commit = (token: string, ops: unknown[]) => post(t.app, token, v, ops)

beforeAll(async () => {
  t = await buildTestApp()
  const { accountToken } = await t.account()
  v = (await t.vault(accountToken)).vaultId
  tok = (await t.device(accountToken, v, 'laptop')).deviceToken
  tok2 = (await t.device(accountToken, v, 'phone')).deviceToken
})
afterAll(async () => {
  await t.close()
})

describe('commit, changes, manifest', () => {
  it('creates, modifies, moves, deletes and replays the feed into the manifest', async () => {
    await putBlob(tok, '# one\n')
    let r = await commit(tok, [create('One.md', '# one\n')])
    expect(r.results[0]).toMatchObject({ status: 'applied', seq: 1, path: 'One.md' })
    const fileId = r.results[0].file_id,
      v1 = r.results[0].version_id
    const s2 = await putBlob(tok, '# one!\n')
    r = await commit(tok, [
      { op: 'modify', file_id: fileId, base_version_id: v1, sha: s2, size: 7, mtime: 2 },
    ])
    const v2 = r.results[0].version_id
    r = await commit(tok, [
      { op: 'move', file_id: fileId, base_version_id: v2, to_path: 'Notes/One.md' },
    ])
    expect(r.results[0]).toMatchObject({ status: 'applied', path: 'Notes/One.md', seq: 3 })
    expect(CommitResponseSchema.parse(r).head_seq).toBe(3)
    const feed = await api(t.app, tok).get(`/v1/vaults/${v}/changes?since=0`)
    expect(feed.status).toBe(200)
    ChangesResponseSchema.parse(feed.body)
    expect(feed.body.items.map((i: any) => [i.seq, i.op, i.path, i.prev_path])).toEqual([
      [1, 'create', 'One.md', null],
      [2, 'modify', 'One.md', null],
      [3, 'move', 'Notes/One.md', 'One.md'],
    ])
    expect(feed.body.items[0].actor).toEqual({
      kind: 'device',
      id: expect.any(String),
      name: 'laptop',
    })
    expect(feed.body.items[2]).toMatchObject({ sha: s2, size: 7, mtime: 2, kind: 'note' })
    expect(feed.body.head_seq).toBe(3)
    expect(feed.body.next_since).toBe(3)
    const man = await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)
    expect(man.status).toBe(200)
    ManifestResponseSchema.parse(man.body)
    expect(man.body.items).toEqual([
      expect.objectContaining({
        file_id: fileId,
        path: 'Notes/One.md',
        sha: s2,
        seq: 3,
        kind: 'note',
      }),
    ])
    expect(man.body.head_seq).toBe(3)
    expect(man.body.next).toBeNull()
    r = await commit(tok, [
      { op: 'delete', file_id: fileId, base_version_id: r.results[0].version_id },
    ])
    expect(r.results[0].status).toBe('applied')
    expect((await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)).body.items).toEqual([])
    expect((await api(t.app, tok).get(`/v1/vaults/${v}/changes?since=3`)).body.items).toEqual([
      expect.objectContaining({ seq: 4, op: 'delete', sha: null, size: null, mtime: null }),
    ])
    expect((await api(t.app, tok).get(`/v1/vaults/${v}/state`)).body.head_seq).toBe(4)
  })

  it('rejects a bad path and a case collision without aborting the batch', async () => {
    await putBlob(tok, 'x')
    await putBlob(tok, 'y')
    await commit(tok, [create('Dup.md', 'x')])
    const r = await commit(tok, [
      create('a:b.md', 'x'),
      create('ok.md', 'x'),
      create('dup.MD', 'y', 0),
    ])
    expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'invalid_path' })
    expect(r.results[1].status).toBe('applied')
    expect(r.results[2].status).toBe('merged') // create-vs-create on a note: merged from an empty base
    expect(r.results[2].path).toBe('Dup.md')
    expect(r.results[2].sha).not.toBe(shaOf('y'))
  })

  it('merges two devices editing one note', async () => {
    await putBlob(tok, 'a\nb\nc\n')
    const r0 = await commit(tok, [create('m.md', 'a\nb\nc\n')])
    const f = r0.results[0].file_id,
      base = r0.results[0].version_id
    const sPhone = await putBlob(tok2, 'A\nb\nc\n')
    const r1 = await commit(tok2, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sPhone, size: 6, mtime: 10 },
    ])
    expect(r1.results[0].status).toBe('applied')
    const sLaptop = await putBlob(tok, 'a\nb\nC\n')
    const r2 = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sLaptop, size: 6, mtime: 11 },
    ])
    expect(r2.results[0]).toMatchObject({
      status: 'merged',
      sha: shaOf('A\nb\nC\n'),
      size: 6,
      path: 'm.md',
    })
    const blob = await api(t.app, tok).raw({ method: 'GET', url: `/v1/blobs/${r2.results[0].sha}` })
    expect(blob.raw).toBe('A\nb\nC\n')
    const vers = await api(t.app, tok).get(`/v1/vaults/${v}/changes?since=0`)
    // What the laptop sent is kept as a version of its own, just under the merge.
    const items = vers.body.items.filter((i: any) => i.file_id === f)
    expect(items.map((i: any) => i.op)).toEqual(['create', 'modify', 'modify', 'merge'])
    expect(items[2].sha).toBe(sLaptop)
    const merged = await t.db
      .selectFrom('versions')
      .select('merge')
      .where('id', '=', r2.results[0].version_id)
      .executeTakeFirstOrThrow()
    expect(JSON.parse(merged.merge ?? 'null')).toEqual({
      base_version_id: base,
      head_version_id: r1.results[0].version_id,
      incoming_sha: sLaptop,
      clean: true,
    })
  })

  it('reports applied when the merge lands exactly on what the device sent', async () => {
    await putBlob(tok, 'p\nq\n')
    const r0 = await commit(tok, [create('same.md', 'p\nq\n')])
    const f = r0.results[0].file_id,
      base = r0.results[0].version_id
    const s = await putBlob(tok2, 'p\nq\nr\n')
    await commit(tok2, [
      { op: 'modify', file_id: f, base_version_id: base, sha: s, size: 6, mtime: 10 },
    ])
    const r = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: base, sha: s, size: 6, mtime: 11 },
    ])
    expect(r.results[0]).toMatchObject({ status: 'applied', file_id: f, path: 'same.md' })
    const ops = (await api(t.app, tok).get(`/v1/vaults/${v}/changes?since=0`)).body.items
      .filter((i: any) => i.file_id === f)
      .map((i: any) => i.op)
    expect(ops).toEqual(['create', 'modify', 'merge'])
  })

  it('makes a conflict copy in conflict-file mode', async () => {
    await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, { conflict: 'conflict-file' })
    await putBlob(tok, 'title\n')
    const r0 = await commit(tok, [create('c.md', 'title\n')])
    const f = r0.results[0].file_id,
      base = r0.results[0].version_id
    const sA = await putBlob(tok2, 'title A\n')
    const rA = await commit(tok2, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sA, size: 8, mtime: 10 },
    ])
    const sB = await putBlob(tok, 'title B\n')
    const r = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sB, size: 8, mtime: 11 },
    ])
    expect(r.results[0].status).toBe('conflict')
    expect(r.results[0]).toMatchObject({
      file_id: f,
      version_id: rA.results[0].version_id,
      seq: rA.results[0].seq,
      path: 'c.md',
    })
    expect(r.results[0].conflict_path).toMatch(/^c \(Conflicted copy laptop \d{12}\)\.md$/)
    expect(r.results[0].conflict_file_id).not.toBe(f)
    const man = await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)
    const paths = man.body.items.map((i: any) => i.path)
    expect(paths).toContain('c.md')
    expect(paths).toContain(r.results[0].conflict_path)
    expect(man.body.items.find((i: any) => i.path === 'c.md').sha).toBe(sA)
    const copy = man.body.items.find((i: any) => i.path === r.results[0].conflict_path)
    expect(copy).toMatchObject({
      file_id: r.results[0].conflict_file_id,
      version_id: r.results[0].conflict_version_id,
      sha: sB,
    })
    const feed = (await api(t.app, tok).get(`/v1/vaults/${v}/changes?since=0`)).body.items
    expect(feed.find((i: any) => i.version_id === r.results[0].conflict_version_id).op).toBe(
      'conflict'
    )
    await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, { conflict: 'merge' })
  })

  it('keeps the newer attachment and sends the older device the winner', async () => {
    const img0 = Buffer.from('img0')
    await putBlob(tok, img0)
    const r0 = await commit(tok, [
      { op: 'create', path: 'i.png', sha: shaOf(img0), size: 4, mtime: 1 },
    ])
    const f = r0.results[0].file_id,
      base = r0.results[0].version_id
    const newer = Buffer.from('newer')
    const sNew = await putBlob(tok2, newer)
    const rNew = await commit(tok2, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sNew, size: 5, mtime: 100 },
    ])
    const older = Buffer.from('older')
    const sOld = await putBlob(tok, older)
    const r = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sOld, size: 5, mtime: 50 },
    ])
    expect(r.results[0]).toMatchObject({
      status: 'merged',
      sha: sNew,
      mtime: 100,
      size: 5,
      seq: rNew.results[0].seq + 2,
      path: 'i.png',
    })
    // The losing bytes are a version in history, and the winner is the head again after them.
    expect(r.head_seq).toBe(rNew.head_seq + 2)
    const history = (await api(t.app, tok).get(`/v1/vaults/${v}/files/${f}/versions`)).body
    expect(history.map((x: any) => [x.op, x.sha, x.mtime])).toEqual([
      ['merge', sNew, 100],
      ['modify', sOld, 50],
      ['modify', sNew, 100],
      ['create', shaOf(img0), 1],
    ])
    expect(history[0]).toMatchObject({
      version_id: r.results[0].version_id,
      merge: {
        base_version_id: base,
        head_version_id: rNew.results[0].version_id,
        incoming_sha: sOld,
        clean: false,
      },
    })
    expect(
      (await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)).body.items.find(
        (i: any) => i.path === 'i.png'
      ).sha
    ).toBe(sNew)
    // The other way round: an even newer file from the old base replaces the head outright.
    const newest = Buffer.from('newest')
    const sNewest = await putBlob(tok, newest)
    const r2 = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sNewest, size: 6, mtime: 200 },
    ])
    expect(r2.results[0]).toMatchObject({ status: 'applied', path: 'i.png' })
  })

  it('treats a second identical create as already applied', async () => {
    await putBlob(tok, 'twice')
    const r0 = await commit(tok, [create('twice.md', 'twice')])
    const r1 = await commit(tok, [create('twice.md', 'twice', 99)])
    // The head is the answer, down to its mtime: nothing was written, so the 99 sent the
    // second time is not what the file holds.
    expect(r1.results[0]).toEqual({
      status: 'applied',
      file_id: r0.results[0].file_id,
      version_id: r0.results[0].version_id,
      seq: r0.results[0].seq,
      path: 'twice.md',
      sha: r0.results[0].sha,
      size: r0.results[0].size,
      mtime: r0.results[0].mtime,
    })
    expect(r1.head_seq).toBe(r0.head_seq)
    const versions = await t.db
      .selectFrom('versions')
      .select('id')
      .where('file_id', '=', r0.results[0].file_id)
      .execute()
    expect(versions).toHaveLength(1)
    const ref = await t.db
      .selectFrom('blobs')
      .select('refs')
      .where('sha', '=', shaOf('twice'))
      .executeTakeFirstOrThrow()
    expect(ref.refs).toBe(1)
  })

  it('keeps the losing attachment once: the same bytes sent again write nothing', async () => {
    const win = Buffer.from('Image.png, the newer one')
    const lose = Buffer.from('image.png, the older one')
    await putBlob(tok, win)
    await putBlob(tok, lose)
    const r0 = await commit(tok, [create('Image.png', win, 100)])
    const f = r0.results[0].file_id
    const first = await commit(tok, [create('image.png', lose, 50)])
    expect(first.results[0]).toMatchObject({ status: 'merged', file_id: f, sha: shaOf(win) })
    const kept = first.results[0]
    // What a case-sensitive disk holding both spellings sends on every sync after that.
    for (let round = 0; round < 3; round++) {
      const again = await commit(tok, [create('image.png', lose, 50)])
      expect(again.results[0]).toMatchObject({
        status: 'merged',
        file_id: f,
        version_id: kept.version_id,
        seq: kept.seq,
        sha: shaOf(win),
      })
      expect(again.head_seq).toBe(first.head_seq)
    }
    // A stale modify carrying bytes the history already holds keeps nothing more either.
    const stale = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: 'gone', sha: shaOf(lose), size: 24, mtime: 7 },
    ])
    expect(stale.results[0]).toMatchObject({ status: 'merged', version_id: kept.version_id })
    const history = (await api(t.app, tok).get(`/v1/vaults/${v}/files/${f}/versions`)).body
    expect(history.map((x: any) => x.op)).toEqual(['merge', 'modify', 'create'])
  })

  it('merges a note from the same base once: the same bytes sent again write nothing', async () => {
    await putBlob(tok, 'upper\n')
    await putBlob(tok, 'lower\n')
    const r0 = await commit(tok, [create('Twin.md', 'upper\n')])
    const f = r0.results[0].file_id
    const first = await commit(tok, [create('twin.md', 'lower\n', 5)])
    expect(first.results[0]).toMatchObject({ status: 'merged', file_id: f })
    for (let round = 0; round < 3; round++) {
      const again = await commit(tok, [create('twin.md', 'lower\n', 5)])
      expect(again.results[0]).toMatchObject({
        status: 'merged',
        version_id: first.results[0].version_id,
        sha: first.results[0].sha,
      })
      expect(again.head_seq).toBe(first.head_seq)
    }
    const history = (await api(t.app, tok).get(`/v1/vaults/${v}/files/${f}/versions`)).body
    // The merge and the sent text kept under it, once.
    expect(history.map((x: any) => x.op)).toEqual(['merge', 'modify', 'create'])
    expect(history[1].sha).toBe(shaOf('lower\n'))
    // A real edit from a known base still merges: only the same bytes from the same base are known.
    const edited = await putBlob(tok2, 'upper\nmore\n')
    const r = await commit(tok2, [
      {
        op: 'modify',
        file_id: f,
        base_version_id: r0.results[0].version_id,
        sha: edited,
        size: 11,
        mtime: 9,
      },
    ])
    expect(r.results[0].version_id).not.toBe(first.results[0].version_id)
  })

  it('rejects a blob that was never uploaded', async () => {
    const r = await commit(tok, [
      { op: 'create', path: 'ghost.md', sha: 'e'.repeat(64), size: 1, mtime: 1 },
    ])
    expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'not_found' })
    const man = await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)
    expect(man.body.items.map((i: any) => i.path)).not.toContain('ghost.md')
  })

  it('refuses a file over max_file_bytes and a commit over quota', async () => {
    await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, { max_file_bytes: 10 })
    const big = 'x'.repeat(11)
    await putBlob(tok, big)
    let r = await commit(tok, [create('big.md', big)])
    expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'too_large' })
    await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, {
      max_file_bytes: 200 * 1024 * 1024,
      quota_bytes: 1,
      account_password: TEST_PASSWORD,
    })
    r = await commit(tok, [create('q.md', 'xx')])
    expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'quota_exceeded' })
    const reset = await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, {
      quota_bytes: null,
      account_password: TEST_PASSWORD,
    })
    expect(reset.status).toBe(200)
  })

  it('counts the replaced head out of the quota', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await api(tt.app, d).patch(`/v1/vaults/${vv}/settings`, {
      quota_bytes: 5,
      account_password: TEST_PASSWORD,
    })
    await put(tt.app, d, 'abcd')
    const r0 = await post(tt.app, d, vv, [create('q.md', 'abcd')])
    expect(r0.results[0].status).toBe('applied')
    const s = await put(tt.app, d, 'abcde')
    // Uploads nobody has committed count against the quota as well, so the byte that would
    // not fit beside them is turned away at the door, told to ask again once they are committed.
    const x = await api(tt.app, d).raw({
      method: 'PUT',
      url: `/v1/blobs/${shaOf('x')}`,
      payload: Buffer.from('x'),
      headers: octet,
    })
    expect(x.body.error.code).toBe('quota_waiting')
    // 4 live, replacing them with 5 stays at the quota; a second file of 1 byte would not.
    const r1 = await post(tt.app, d, vv, [
      {
        op: 'modify',
        file_id: r0.results[0].file_id,
        base_version_id: r0.results[0].version_id,
        sha: s,
        size: 5,
        mtime: 2,
      },
      create('one.md', 'x'),
    ])
    expect(r1.results[0].status).toBe('applied')
    expect(r1.results[1]).toMatchObject({ status: 'rejected', code: 'quota_exceeded' })
    await tt.close()
  })

  it('paginates the manifest by path', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await api(tt.app, d).raw({
      method: 'PUT',
      url: `/v1/blobs/${shaOf('p')}`,
      payload: Buffer.from('p'),
      headers: octet,
    })
    await api(tt.app, d).post(`/v1/vaults/${vv}/commit`, {
      ops: ['e', 'a', 'c', 'b', 'd'].map((n) => ({
        op: 'create',
        path: `${n}.md`,
        sha: shaOf('p'),
        size: 1,
        mtime: 1,
      })),
    })
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const page = await api(tt.app, d).get(
        `/v1/vaults/${vv}/manifest?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      )
      expect(page.status).toBe(200)
      seen.push(...page.body.items.map((i: any) => i.path))
      cursor = page.body.next
      pages++
    } while (cursor)
    expect(seen).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
    expect(pages).toBe(3)
    await tt.close()
  })

  it('pages the change feed and reports next_since on an empty page', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await put(tt.app, d, 'p')
    await post(
      tt.app,
      d,
      vv,
      ['a', 'b', 'c'].map((n) => create(`${n}.md`, 'p'))
    )
    const first = await api(tt.app, d).get(`/v1/vaults/${vv}/changes?since=0&limit=2`)
    expect(first.body.items.map((i: any) => i.seq)).toEqual([1, 2])
    expect(first.body).toMatchObject({ next_since: 2, head_seq: 3 })
    const second = await api(tt.app, d).get(`/v1/vaults/${vv}/changes?since=2&limit=2`)
    expect(second.body.items.map((i: any) => i.seq)).toEqual([3])
    expect(second.body).toMatchObject({ next_since: 3, head_seq: 3 })
    const empty = await api(tt.app, d).get(`/v1/vaults/${vv}/changes?since=3`)
    expect(empty.body).toEqual({ items: [], next_since: 3, head_seq: 3 })
    expect((await api(tt.app, d).get(`/v1/vaults/${vv}/changes?since=-1`)).status).toBe(400)
    expect((await api(tt.app, d).get(`/v1/vaults/${vv}/changes?limit=0`)).status).toBe(400)
    expect((await api(tt.app, d).get(`/v1/vaults/${vv}/manifest?limit=5001`)).status).toBe(400)
    await tt.close()
  })

  it('restores a deleted file at its path, or beside it when the path is taken', async () => {
    await putBlob(tok, 'r')
    const r0 = await commit(tok, [create('r.md', 'r')])
    const f = r0.results[0].file_id
    await commit(tok, [{ op: 'delete', file_id: f, base_version_id: r0.results[0].version_id }])
    const again = await commit(tok, [create('r.md', 'r')])
    // A create where a file was deleted is a new file; the deleted one waits in the trash.
    expect(again.results[0].status).toBe('applied')
    expect(again.results[0].file_id).not.toBe(f)
    const rows = await t.db
      .selectFrom('files')
      .select(['id', 'path', 'deleted_at'])
      .where('vault_id', '=', v)
      .where('path_ci', '=', 'r.md')
      .execute()
    expect(rows.find((row) => row.id === f)?.deleted_at).toEqual(expect.any(String))
    expect(rows.find((row) => row.id === again.results[0].file_id)).toMatchObject({
      path: 'r.md',
      deleted_at: null,
    })
    const r = await commit(tok, [
      { op: 'restore', file_id: f, version_id: r0.results[0].version_id },
    ])
    expect(r.results[0]).toMatchObject({ status: 'applied', path: 'r 1.md', file_id: f })
    const man = await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)
    expect(man.body.items.find((i: any) => i.path === 'r 1.md')).toMatchObject({
      file_id: f,
      sha: shaOf('r'),
      version_id: r.results[0].version_id,
    })
  })

  it('a modify over a deleted head whose path another live file took lands at the next free name', async () => {
    await putBlob(tok, 'old m')
    const first = await commit(tok, [create('m.md', 'old m')])
    const f = first.results[0].file_id
    const v1 = first.results[0].version_id
    await commit(tok, [{ op: 'delete', file_id: f, base_version_id: v1 }])
    await putBlob(tok, 'new m')
    const taken = await commit(tok, [create('m.md', 'new m')])
    expect(taken.results[0].file_id).not.toBe(f)

    const s = await putBlob(tok, 'old m, edited')
    const r = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: v1, sha: s, size: 13, mtime: 5 },
    ])
    expect(r.results[0]).toMatchObject({ status: 'applied', file_id: f, path: 'm 1.md' })
    const man = await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)
    const atM = man.body.items.filter((i: any) => i.path.toLowerCase().startsWith('m'))
    expect(atM.map((i: any) => [i.path, i.file_id, i.sha]).sort()).toEqual([
      ['m 1.md', f, s],
      ['m.md', taken.results[0].file_id, shaOf('new m')],
    ])
  })

  it('restores a deleted file at its own path when it is free', async () => {
    await putBlob(tok, 'own')
    const r0 = await commit(tok, [create('own.md', 'own')])
    const f = r0.results[0].file_id
    const sMod = await putBlob(tok, 'own2')
    const r1 = await commit(tok, [
      {
        op: 'modify',
        file_id: f,
        base_version_id: r0.results[0].version_id,
        sha: sMod,
        size: 4,
        mtime: 2,
      },
    ])
    await commit(tok, [{ op: 'delete', file_id: f, base_version_id: r1.results[0].version_id }])
    expect(
      (await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)).body.items.map((i: any) => i.path)
    ).not.toContain('own.md')
    const r = await commit(tok, [
      { op: 'restore', file_id: f, version_id: r0.results[0].version_id },
    ])
    expect(r.results[0]).toMatchObject({ status: 'applied', path: 'own.md', file_id: f })
    const item = (await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)).body.items.find(
      (i: any) => i.path === 'own.md'
    )
    expect(item).toMatchObject({ file_id: f, sha: shaOf('own'), size: 3 })
    const feed = (await api(t.app, tok).get(`/v1/vaults/${v}/changes?since=0`)).body.items.filter(
      (i: any) => i.file_id === f
    )
    expect(feed.map((i: any) => i.op)).toEqual(['create', 'modify', 'delete', 'restore'])
    // A restore names a version of another file: nothing to restore.
    const bad = await commit(tok, [{ op: 'restore', file_id: f, version_id: 'nope' }])
    expect(bad.results[0]).toMatchObject({ status: 'rejected', code: 'not_found' })
  })

  it('rejects a stale move and a stale base the way the table says', async () => {
    await putBlob(tok, 'mv')
    const r0 = await commit(tok, [create('mv.md', 'mv')])
    const f = r0.results[0].file_id,
      base = r0.results[0].version_id
    const other = await commit(tok, [create('taken.md', 'mv')])
    const r = await commit(tok, [
      { op: 'move', file_id: f, base_version_id: base, to_path: 'taken.md' },
      // Row 22: a version the vault has, of another file — the client's mistake.
      {
        op: 'move',
        file_id: f,
        base_version_id: other.results[0].version_id,
        to_path: 'free.md',
      },
      { op: 'delete', file_id: 'no-such-file', base_version_id: base },
      { op: 'move', file_id: f, base_version_id: base, to_path: 'MV.md' },
    ])
    expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'path_taken' })
    expect(r.results[1]).toMatchObject({ status: 'rejected', code: 'invalid_request' })
    expect(r.results[2]).toMatchObject({ status: 'rejected', code: 'not_found' })
    // A case-only rename is not a collision with itself.
    expect(r.results[3]).toMatchObject({ status: 'applied', path: 'MV.md' })

    // Row 23: a base the vault has no row for is a head that changed, not a
    // mistake — the move applies, carrying the head's blob to the free path.
    const gone = await commit(tok, [
      { op: 'move', file_id: f, base_version_id: 'zz', to_path: 'free.md' },
    ])
    expect(gone.results[0]).toMatchObject({ status: 'applied', file_id: f, path: 'free.md' })
    const man = await api(t.app, tok).get(`/v1/vaults/${v}/manifest`)
    expect(man.body.items.find((i: any) => i.path === 'free.md')).toMatchObject({
      file_id: f,
      sha: shaOf('mv'),
    })
  })

  it('writes one audit row per op', async () => {
    await putBlob(tok, 'audit')
    const r = await commit(tok, [create('audit.md', 'audit'), create('a:b', 'audit')])
    const rows = await t.db
      .selectFrom('audit')
      .select(['action', 'result', 'path', 'actor_kind'])
      .where('vault_id', '=', v)
      .orderBy('at', 'desc')
      .orderBy('id')
      .execute()
    const mine = rows.filter((row) => row.path === 'audit.md' || row.path === 'a:b')
    expect(mine).toEqual(
      expect.arrayContaining([
        { action: 'create', result: 'applied', path: 'audit.md', actor_kind: 'device' },
        { action: 'create', result: 'rejected:invalid_path', path: 'a:b', actor_kind: 'device' },
      ])
    )
    expect(r.results).toHaveLength(2)
  })
})

describe('when an op breaks after it started writing', () => {
  it('fails the whole batch with the error, and nothing of it lands', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await put(tt.app, d, 'gone')
    // The blob is there for the pre-write check and gone by the time the ref is counted.
    const has = tt.store.has.bind(tt.store)
    let calls = 0
    tt.store.has = async (sha) => (++calls === 1 ? has(sha) : false)
    const r = await api(tt.app, d).post(`/v1/vaults/${vv}/commit`, {
      ops: [create('gone.md', 'gone'), create('other.md', 'gone')],
    })
    tt.store.has = has
    expect(r.status).toBe(404)
    expect(r.body.error.code).toBe('not_found')
    expect(await tt.db.selectFrom('versions').select('id').execute()).toEqual([])
    expect(await tt.db.selectFrom('files').select('id').execute()).toEqual([])
    const seq = await tt.db
      .selectFrom('vault_seq')
      .select('head_seq')
      .where('vault_id', '=', vv)
      .executeTakeFirstOrThrow()
    expect(seq.head_seq).toBe(0)
    await tt.close()
  })

  it('answers 500 for a corrupt row instead of a rejection', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await put(tt.app, d, 'rot')
    const r0 = await post(tt.app, d, vv, [create('rot.md', 'rot')])
    const f = r0.results[0].file_id
    await tt.db.updateTable('files').set({ head_version_id: null }).where('id', '=', f).execute()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await api(tt.app, d).post(`/v1/vaults/${vv}/commit`, {
      ops: [{ op: 'delete', file_id: f, base_version_id: r0.results[0].version_id }],
    })
    try {
      expect(r.status).toBe(500)
      expect(r.body).toEqual({
        error: { code: 'internal', message: 'internal error', details: {} },
      })
      expect(r.raw).not.toContain('head version')
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    await tt.close()
  })

  it('answers 500, not a rejection, when the blob a stored version names is gone', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv, 'laptop')).deviceToken
    const d2 = (await tt.device(accountToken, vv, 'phone')).deviceToken
    await put(tt.app, d, 'a\nb\n')
    const r0 = await post(tt.app, d, vv, [create('m.md', 'a\nb\n')])
    const f = r0.results[0].file_id
    const base = r0.results[0].version_id
    const sHead = await put(tt.app, d2, 'a\nb\nc\n')
    await post(tt.app, d2, vv, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sHead, size: 6, mtime: 10 },
    ])
    // The head's bytes go: a lost disk, nothing the client did or can mend by uploading.
    await tt.store.delete(sHead)
    const sMine = await put(tt.app, d, 'A\nb\n')
    const before = (await api(tt.app, d).get(`/v1/vaults/${vv}/state`)).body.head_seq

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A merge needs the head's text.
      const merge = await api(tt.app, d).post(`/v1/vaults/${vv}/commit`, {
        ops: [{ op: 'modify', file_id: f, base_version_id: base, sha: sMine, size: 4, mtime: 11 }],
      })
      expect(merge.status).toBe(500)
      expect(merge.body).toEqual({
        error: { code: 'internal', message: 'internal error', details: {} },
      })
      expect(merge.raw).not.toContain(sHead)
      // A move writes the head's blob again; "has not been uploaded" is for the op's own sha only.
      const move = await api(tt.app, d).post(`/v1/vaults/${vv}/commit`, {
        ops: [{ op: 'move', file_id: f, base_version_id: base, to_path: 'moved.md' }],
      })
      expect(move.status).toBe(500)
      expect(move.body.error).toMatchObject({ code: 'internal', message: 'internal error' })
      expect(logged).toHaveBeenCalledTimes(2)
    } finally {
      logged.mockRestore()
    }
    // Neither batch landed anything.
    expect((await api(tt.app, d).get(`/v1/vaults/${vv}/state`)).body.head_seq).toBe(before)
    await tt.close()
  })

  it('still answers a landed commit when the audit row cannot be written', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await put(tt.app, d, 'audit')
    await tt.db.schema.dropTable('audit').execute()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await api(tt.app, d).post(`/v1/vaults/${vv}/commit`, {
      ops: [create('a.md', 'audit')],
    })
    try {
      expect(r.status).toBe(200)
      expect(r.body.results[0]).toMatchObject({ status: 'applied', seq: 1, path: 'a.md' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    expect((await api(tt.app, d).get(`/v1/vaults/${vv}/state`)).body.head_seq).toBe(1)
    await tt.close()
  })

  it('quota-checks a restore by the size it brings back', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = (await tt.device(accountToken, vv)).deviceToken
    await put(tt.app, d, 'four')
    const r0 = await post(tt.app, d, vv, [create('q.md', 'four')])
    const f = r0.results[0].file_id
    await post(tt.app, d, vv, [
      { op: 'delete', file_id: f, base_version_id: r0.results[0].version_id },
    ])
    await api(tt.app, d).patch(`/v1/vaults/${vv}/settings`, {
      quota_bytes: 3,
      account_password: TEST_PASSWORD,
    })
    const r = await post(tt.app, d, vv, [
      { op: 'restore', file_id: f, version_id: r0.results[0].version_id },
    ])
    expect(r.results[0]).toMatchObject({ status: 'rejected', code: 'quota_exceeded' })
    const raised = await api(tt.app, d).patch(`/v1/vaults/${vv}/settings`, {
      quota_bytes: 4,
      account_password: TEST_PASSWORD,
    })
    expect(raised.status).toBe(200)
    const ok = await post(tt.app, d, vv, [
      { op: 'restore', file_id: f, version_id: r0.results[0].version_id },
    ])
    expect(ok.results[0]).toMatchObject({ status: 'applied', path: 'q.md' })
    await tt.close()
  })
})

describe('the manifest under a commit', () => {
  it('never reports a head past a file it did not list', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const vv = (await tt.vault(accountToken)).vaultId
    const d = await tt.device(accountToken, vv, 'd')
    await put(tt.app, d.deviceToken, 'first')
    await put(tt.app, d.deviceToken, 'raced')
    const deps = { db: tt.db, dialect: 'sqlite' as const, store: tt.store, hub: new EventHub() }
    const actor = { kind: 'device' as const, id: d.deviceId, name: 'd' }
    await commitDirect(deps, vv, actor, [create('first.md', 'first')])

    // The two are started together. The connection is one and hands out queries in the order
    // they were asked, so the commit's transaction runs between the manifest's two reads —
    // whichever of them comes first.
    const [page, committed] = await Promise.all([
      manifest(tt.db, vv, null, 1000),
      commitDirect(deps, vv, actor, [create('raced.md', 'raced')]),
    ])
    const raced = committed.results[0]
    expect(raced?.status).toBe('applied')
    const racedSeq = raced?.status === 'applied' ? raced.seq : -1
    // Either the page lists the raced file, or its head stops short of the file's seq, so a
    // device following the feed from that head meets the file there. Never neither.
    const listed = page.items.some((item) => item.path === 'raced.md')
    expect(listed || page.head_seq < racedSeq).toBe(true)
    await tt.close()
  })
})

describe('the vault lock', () => {
  it('serialises two commits to one vault into seqs 1 and 2, and keeps vaults apart', async () => {
    const tt = await buildTestApp()
    const { accountToken } = await tt.account()
    const va = (await tt.vault(accountToken, 'A')).vaultId
    const vb = (await tt.vault(accountToken, 'B')).vaultId
    const da = await tt.device(accountToken, va, 'da')
    const db = await tt.device(accountToken, vb, 'db')
    await put(tt.app, da.deviceToken, 'lock')
    const deps = { db: tt.db, dialect: 'sqlite' as const, store: tt.store, hub: new EventHub() }
    const actor = (d: { deviceId: string }, name: string) => ({
      kind: 'device' as const,
      id: d.deviceId,
      name,
    })

    const [ra, rb] = await Promise.all([
      commitDirect(deps, va, actor(da, 'da'), [create('one.md', 'lock')]),
      commitDirect(deps, va, actor(da, 'da'), [create('two.md', 'lock')]),
    ])
    const seqs = [ra.results[0], rb.results[0]]
      .map((x) => (x?.status === 'applied' ? x.seq : -1))
      .sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2])
    expect(Math.max(ra.head_seq, rb.head_seq)).toBe(2)

    // A digest in A is not an upload by B, even when the shared store has its bytes.
    await put(tt.app, db.deviceToken, 'lock')
    const [xa, xb] = await Promise.all([
      commitDirect(deps, va, actor(da, 'da'), [create('three.md', 'lock')]),
      commitDirect(deps, vb, actor(db, 'db'), [create('one.md', 'lock')]),
    ])
    expect(xa.results[0]).toMatchObject({ status: 'applied', seq: 3 })
    expect(xb.results[0]).toMatchObject({ status: 'applied', seq: 1 })
    await tt.close()
  })
})
