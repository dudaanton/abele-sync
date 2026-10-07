import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  ChangeItemSchema,
  CommitResponseSchema,
  TrashItemSchema,
  UsageSchema,
  VersionInfoSchema,
} from '@abele/sync-protocol'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'
import { api } from '../helpers/client.js'
import { create, putBlob as put, commit as post, shaOf } from '../helpers/ops.js'

let t: TestApp, tok: string, tok2: string, v: string
/** A second vault with its own device: nothing of it may ever show through `v`. */
let other: string, otherTok: string

const putBlob = (token: string, text: string) => put(t.app, token, text)
const commit = (token: string, ops: unknown[]) => post(t.app, token, v, ops)
const get = (url: string, token = tok) => api(t.app, token).get(url)

beforeAll(async () => {
  t = await buildTestApp()
  const { accountToken } = await t.account()
  v = (await t.vault(accountToken)).vaultId
  tok = (await t.device(accountToken, v, 'laptop')).deviceToken
  tok2 = (await t.device(accountToken, v, 'phone')).deviceToken
  other = (await t.vault(accountToken, 'Other')).vaultId
  otherTok = (await t.device(accountToken, other, 'other')).deviceToken
})
afterAll(async () => {
  await t.close()
})

describe('versions, trash, usage, activity', () => {
  it('lists versions newest first, serves any version, restores an old one', async () => {
    for (const text of ['v1', 'v22', 'v333']) await putBlob(tok, text)
    let r = await commit(tok, [create('h.md', 'v1')])
    const f = r.results[0].file_id,
      first = r.results[0].version_id
    r = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: first, sha: shaOf('v22'), size: 3, mtime: 2 },
    ])
    const second = r.results[0].version_id
    await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: second, sha: shaOf('v333'), size: 4, mtime: 3 },
    ])

    const list = await get(`/v1/vaults/${v}/files/${f}/versions`)
    expect(list.status).toBe(200)
    for (const item of list.body) VersionInfoSchema.parse(item)
    expect(list.body.map((i: any) => i.no)).toEqual([3, 2, 1])
    expect(list.body.map((i: any) => i.op)).toEqual(['modify', 'modify', 'create'])
    expect(list.body.map((i: any) => i.size)).toEqual([4, 3, 2])
    expect(list.body[2]).toMatchObject({
      version_id: first,
      sha: shaOf('v1'),
      path: 'h.md',
      merge: null,
      actor: { kind: 'device', name: 'laptop' },
    })

    const blob = await get(`/v1/vaults/${v}/files/${f}/versions/${first}`)
    expect(blob.status).toBe(200)
    expect(blob.buffer.toString('utf8')).toBe('v1')
    expect(blob.headers['content-type']).toContain('application/octet-stream')
    expect(blob.headers['content-length']).toBe('2')
    expect(blob.headers['cache-control']).toContain('immutable')
    expect(blob.headers['accept-ranges']).toBe('bytes')

    // A version is served exactly as a blob is, ranges and refusals included.
    const url = `/v1/vaults/${v}/files/${f}/versions/${list.body[0].version_id}`
    const part = await api(t.app, tok).raw({ method: 'GET', url, headers: { range: 'bytes=0-1' } })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe('bytes 0-1/4')
    expect(part.buffer.toString('utf8')).toBe('v3')
    const past = await api(t.app, tok).raw({ method: 'GET', url, headers: { range: 'bytes=9-' } })
    expect(past.status).toBe(416)
    expect(past.headers['content-range']).toBe('bytes */4')

    const restored = await api(t.app, tok).post(`/v1/vaults/${v}/files/${f}/restore`, {
      version_id: first,
    })
    expect(restored.status).toBe(200)
    expect(restored.body).toMatchObject({ status: 'applied', file_id: f, path: 'h.md' })
    expect(restored.body.version_id).not.toBe(first)

    const after = await get(`/v1/vaults/${v}/files/${f}/versions`)
    expect(after.body).toHaveLength(4)
    expect(after.body[0]).toMatchObject({
      no: 4,
      op: 'restore',
      sha: shaOf('v1'),
      size: 2,
      version_id: restored.body.version_id,
    })

    const elsewhere = await commit(tok, [create('h-other.md', 'v22')])
    const bad = await get(`/v1/vaults/${v}/files/${f}/versions/${elsewhere.results[0].version_id}`)
    expect(bad.status).toBe(404)
    expect(bad.body.error.code).toBe('not_found')
  })

  it('pages versions with limit and before', async () => {
    for (const text of ['p1', 'p22', 'p333', 'p4444']) await putBlob(tok, text)
    let r = await commit(tok, [create('page.md', 'p1')])
    const f = r.results[0].file_id
    for (const text of ['p22', 'p333', 'p4444']) {
      r = await commit(tok, [
        {
          op: 'modify',
          file_id: f,
          base_version_id: r.results[0].version_id,
          sha: shaOf(text),
          size: text.length,
          mtime: 5,
        },
      ])
    }
    const first = await get(`/v1/vaults/${v}/files/${f}/versions?limit=2`)
    expect(first.body.map((i: any) => i.no)).toEqual([4, 3])
    const next = await get(`/v1/vaults/${v}/files/${f}/versions?limit=2&before=3`)
    expect(next.body.map((i: any) => i.no)).toEqual([2, 1])
    expect((await get(`/v1/vaults/${v}/files/${f}/versions?before=1`)).body).toEqual([])
    expect((await get(`/v1/vaults/${v}/files/${f}/versions?limit=0`)).status).toBe(400)
  })

  it('restoring the version a file already shows writes nothing', async () => {
    await putBlob(tok, 'same')
    const r = await commit(tok, [create('same.md', 'same')])
    const f = r.results[0].file_id,
      version = r.results[0].version_id
    const before = (await get(`/v1/vaults/${v}/state`)).body.head_seq

    const again = await api(t.app, tok).post(`/v1/vaults/${v}/files/${f}/restore`, {
      version_id: version,
    })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ status: 'applied', file_id: f, version_id: version })
    expect((await get(`/v1/vaults/${v}/files/${f}/versions`)).body).toHaveLength(1)
    expect((await get(`/v1/vaults/${v}/state`)).body.head_seq).toBe(before)
  })

  it('lists the trash and restores from it', async () => {
    await putBlob(tok, 'tt')
    let r = await commit(tok, [create('t.md', 'tt')])
    const f = r.results[0].file_id,
      v1 = r.results[0].version_id
    await commit(tok, [{ op: 'delete', file_id: f, base_version_id: v1 }])

    const trash = await get(`/v1/vaults/${v}/trash`)
    expect(trash.status).toBe(200)
    for (const item of trash.body) TrashItemSchema.parse(item)
    expect(trash.body).toEqual([
      expect.objectContaining({
        file_id: f,
        path: 't.md',
        kind: 'note',
        size: 2,
        last_version_id: v1,
      }),
    ])

    const back = await api(t.app, tok).post(`/v1/vaults/${v}/trash/${f}/restore`)
    expect(back.status).toBe(200)
    expect(back.body).toMatchObject({ status: 'applied', file_id: f, path: 't.md' })
    expect((await get(`/v1/vaults/${v}/trash`)).body).toEqual([])
    const man = await get(`/v1/vaults/${v}/manifest`)
    expect(man.body.items.map((i: any) => i.path)).toContain('t.md')

    // What came back is the version the listing named, byte for byte.
    const history = await get(`/v1/vaults/${v}/files/${f}/versions`)
    const named = history.body.find((i: any) => i.version_id === trash.body[0].last_version_id)
    expect(history.body[0]).toMatchObject({ op: 'restore', sha: named.sha, size: named.size })

    for (const text of ['uu', 'uuu']) await putBlob(tok, text)
    r = await commit(tok, [create('u.md', 'uu')])
    const u = r.results[0].file_id
    await commit(tok, [{ op: 'delete', file_id: u, base_version_id: r.results[0].version_id }])
    const again = await commit(tok, [create('u.md', 'uuu')])
    expect(again.results[0].file_id).not.toBe(u)

    const dug = await api(t.app, tok).post(`/v1/vaults/${v}/trash/${u}/restore`)
    expect(dug.body).toMatchObject({ status: 'applied', file_id: u, path: 'u 1.md' })
    expect((await get(`/v1/vaults/${v}/trash`)).body).toEqual([])
  })

  it('says which device deleted each file in the trash', async () => {
    for (const text of ['by-laptop', 'by-phone']) await putBlob(tok, text)
    const a = (await commit(tok, [create('dl-a.md', 'by-laptop')])).results[0]
    const b = (await commit(tok, [create('dl-b.md', 'by-phone')])).results[0]
    await commit(tok, [{ op: 'delete', file_id: a.file_id, base_version_id: a.version_id }])
    await commit(tok2, [{ op: 'delete', file_id: b.file_id, base_version_id: b.version_id }])
    const trash = (await get(`/v1/vaults/${v}/trash?path_prefix=dl-`)).body
    for (const item of trash) TrashItemSchema.parse(item)
    const by = (id: string) => trash.find((item: any) => item.file_id === id)?.deleted_by
    expect(by(a.file_id)).toMatchObject({ kind: 'device', name: 'laptop' })
    expect(by(b.file_id)).toMatchObject({ kind: 'device', name: 'phone' })
    // Out of the trash again, for the tests after this one that list all of it.
    for (const { file_id } of [a, b]) {
      await api(t.app, tok).post(`/v1/vaults/${v}/trash/${file_id}/restore`)
    }
  })

  it('refuses a trash restore of a file that is not in the trash', async () => {
    await putBlob(tok, 'alive')
    const r = await commit(tok, [create('alive.md', 'alive')])
    const f = r.results[0].file_id
    const before = (await get(`/v1/vaults/${v}/state`)).body.head_seq

    const res = await api(t.app, tok).post(`/v1/vaults/${v}/trash/${f}/restore`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect((await get(`/v1/vaults/${v}/files/${f}/versions`)).body).toHaveLength(1)
    expect((await get(`/v1/vaults/${v}/state`)).body.head_seq).toBe(before)
  })

  it('filters the trash by path prefix', async () => {
    for (const text of ['xx', 'yy']) await putBlob(tok, text)
    const made = await commit(tok, [create('A/x.md', 'xx'), create('B/y.md', 'yy')])
    for (const result of made.results) {
      await commit(tok, [
        { op: 'delete', file_id: result.file_id, base_version_id: result.version_id },
      ])
    }
    const all = await get(`/v1/vaults/${v}/trash`)
    expect(all.body.map((i: any) => i.path).sort()).toEqual(['A/x.md', 'B/y.md'])
    const only = await get(`/v1/vaults/${v}/trash?path_prefix=A/`)
    expect(only.body.map((i: any) => i.path)).toEqual(['A/x.md'])
    expect((await get(`/v1/vaults/${v}/trash?path_prefix=Nothing/`)).body).toEqual([])
    // The prefix is case-folded, as paths are everywhere else.
    const folded = await get(`/v1/vaults/${v}/trash?path_prefix=a/`)
    expect(folded.body.map((i: any) => i.path)).toEqual(['A/x.md'])
  })

  it('reads a path prefix literally, wildcards and all', async () => {
    for (const text of ['pp', 'qq']) await putBlob(tok, text)
    const made = await commit(tok, [create('P%q.md', 'pp'), create('Pzq.md', 'qq')])
    for (const result of made.results) {
      await commit(tok, [
        { op: 'delete', file_id: result.file_id, base_version_id: result.version_id },
      ])
    }
    // `%` is a character of the path, not a wildcard standing for `z`.
    const literal = await get(`/v1/vaults/${v}/trash?path_prefix=p%`)
    expect(literal.body.map((i: any) => i.path)).toEqual(['P%q.md'])
    const both = await get(`/v1/vaults/${v}/trash?path_prefix=P`)
    expect(both.body.map((i: any) => i.path).sort()).toEqual(['P%q.md', 'Pzq.md'])
  })

  it('reports usage', async () => {
    // A vault of its own, on a clock that cannot cross midnight mid-test.
    const at = new Date('2026-03-04T12:00:00.000Z')
    const u = await buildTestApp({ now: () => at })
    try {
      const { accountToken } = await u.account()
      const vault = (await u.vault(accountToken)).vaultId
      const token = (await u.device(accountToken, vault, 'laptop')).deviceToken
      const send = (ops: unknown[]) => post(u.app, token, vault, ops)
      for (const text of ['aaa', 'aaaaa', 'bbbbbbb', 'cc']) await put(u.app, token, text)

      let r = await send([create('a.md', 'aaa')])
      const a = r.results[0].file_id
      await send([
        {
          op: 'modify',
          file_id: a,
          base_version_id: r.results[0].version_id,
          sha: shaOf('aaaaa'),
          size: 5,
          mtime: 2,
        },
      ])
      await send([create('b.png', 'bbbbbbb')])
      r = await send([create('c.md', 'cc')])
      await send([
        { op: 'delete', file_id: r.results[0].file_id, base_version_id: r.results[0].version_id },
      ])

      const res = await api(u.app, token).get(`/v1/vaults/${vault}/usage`)
      expect(res.status).toBe(200)
      UsageSchema.parse(res.body)
      expect(res.body).toMatchObject({
        live_bytes: 12,
        history_bytes: 3,
        trash_bytes: 2,
        quota_bytes: null,
      })
      expect(res.body.by_kind).toEqual({
        note: { live_bytes: 5, count: 1 },
        attachment: { live_bytes: 7, count: 1 },
      })
      expect(res.body.top[0]).toEqual({
        file_id: a,
        path: 'a.md',
        history_bytes: 3,
        versions: 2,
      })
      // Only a.md has a version it no longer shows; a file without history is left out.
      expect(res.body.top).toHaveLength(1)

      const state = await api(u.app, token).get(`/v1/vaults/${vault}/state`)
      const { top: _top, ...usage } = res.body
      expect(state.body.usage).toEqual(usage)
      const vaults = await api(u.app, accountToken).get('/v1/vaults')
      expect(vaults.body[0].usage).toEqual(usage)

      const days = await u.db
        .selectFrom('usage_daily')
        .selectAll()
        .where('vault_id', '=', vault)
        .execute()
      expect(days).toHaveLength(1)
      expect(days[0]).toMatchObject({
        day: '2026-03-04',
        live_bytes: 12,
        history_bytes: 5,
        trash_bytes: 0,
      })
      expect(JSON.parse(days[0]!.by_kind)).toEqual({
        note: { live_bytes: 5, count: 1 },
        attachment: { live_bytes: 7, count: 1 },
      })

      // The quota comes from the vault's own settings, and the heaviest history leads.
      await api(u.app, token).patch(`/v1/vaults/${vault}/settings`, {
        quota_bytes: 1000,
        account_password: TEST_PASSWORD,
      })
      const b = await api(u.app, token).get(`/v1/vaults/${vault}/manifest`)
      const png = b.body.items.find((i: any) => i.path === 'b.png')
      await put(u.app, token, 'bbbbbbbbb')
      await send([
        {
          op: 'modify',
          file_id: png.file_id,
          base_version_id: png.version_id,
          sha: shaOf('bbbbbbbbb'),
          size: 9,
          mtime: 3,
        },
      ])
      const again = await api(u.app, token).get(`/v1/vaults/${vault}/usage`)
      expect(again.body).toMatchObject({ live_bytes: 14, history_bytes: 10, quota_bytes: 1000 })
      expect(again.body.top).toEqual([
        { file_id: png.file_id, path: 'b.png', history_bytes: 7, versions: 2 },
        { file_id: a, path: 'a.md', history_bytes: 3, versions: 2 },
      ])
    } finally {
      await u.close()
    }
  })

  it('activity lists conflict copies and restores newest first', async () => {
    await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, { conflict: 'conflict-file' })
    await putBlob(tok, 'title\n')
    const r0 = await commit(tok, [create('act.md', 'title\n')])
    const f = r0.results[0].file_id,
      base = r0.results[0].version_id
    const sA = await putBlob(tok2, 'title A\n')
    await commit(tok2, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sA, size: 8, mtime: 10 },
    ])
    const sB = await putBlob(tok, 'title B\n')
    const r = await commit(tok, [
      { op: 'modify', file_id: f, base_version_id: base, sha: sB, size: 8, mtime: 11 },
    ])
    expect(r.results[0].status).toBe('conflict')

    const feed = await get(`/v1/vaults/${v}/activity`)
    expect(feed.status).toBe(200)
    for (const item of feed.body) ChangeItemSchema.parse(item)
    expect(feed.body[0]).toMatchObject({
      op: 'conflict',
      path: r.results[0].conflict_path,
      version_id: r.results[0].conflict_version_id,
      file_id: r.results[0].conflict_file_id,
      sha: sB,
      kind: 'note',
      actor: { kind: 'device', name: 'laptop' },
    })
    expect(feed.body[0].seq).toBeGreaterThan(feed.body[1].seq)

    const restored = await api(t.app, tok).post(`/v1/vaults/${v}/files/${f}/restore`, {
      version_id: base,
    })
    expect(restored.body.status).toBe('applied')
    const after = await get(`/v1/vaults/${v}/activity`)
    expect(after.body[0]).toMatchObject({
      op: 'restore',
      file_id: f,
      version_id: restored.body.version_id,
      path: 'act.md',
    })
    expect(after.body[0].seq).toBeGreaterThan(feed.body[0].seq)
    await api(t.app, tok).patch(`/v1/vaults/${v}/settings`, { conflict: 'merge' })
  })

  it('bounds the activity feed with since and limit', async () => {
    const head = (await get(`/v1/vaults/${v}/state`)).body.head_seq
    const two = await get(`/v1/vaults/${v}/activity?limit=2`)
    expect(two.body.map((i: any) => i.seq)).toEqual([head, head - 1])
    const since = await get(`/v1/vaults/${v}/activity?since=${head - 1}`)
    expect(since.body.map((i: any) => i.seq)).toEqual([head])
    expect((await get(`/v1/vaults/${v}/activity?limit=0`)).status).toBe(400)
    expect((await get(`/v1/vaults/${v}/activity?since=-1`)).status).toBe(400)
  })

  it('never lets one vault see another vault history', async () => {
    await put(t.app, otherTok, 'secret')
    const mine = await commit(tok, [create('mine.md', 'v1')])
    const theirs = await post(t.app, otherTok, other, [create('theirs.md', 'secret')])
    const file = theirs.results[0].file_id,
      version = theirs.results[0].version_id

    expect((await get(`/v1/vaults/${v}/files/${file}/versions`)).status).toBe(404)
    const leak = await get(`/v1/vaults/${v}/files/${mine.results[0].file_id}/versions/${version}`)
    expect(leak.status).toBe(404)
    expect((await get(`/v1/vaults/${v}/files/${file}/versions/${version}`)).status).toBe(404)
    expect((await api(t.app, tok).post(`/v1/vaults/${v}/trash/${file}/restore`)).status).toBe(404)
    const restore = await api(t.app, tok).post(`/v1/vaults/${v}/files/${file}/restore`, {
      version_id: version,
    })
    expect(restore.body).toMatchObject({ status: 'rejected', code: 'not_found' })
    // And the device of one vault cannot ask about the other at all.
    expect((await get(`/v1/vaults/${other}/usage`)).status).toBe(403)
    expect((await get(`/v1/vaults/${other}/trash`)).status).toBe(403)
    expect((await get(`/v1/vaults/${other}/activity`)).status).toBe(403)
  })
})

describe('restoring many files from the trash at once', () => {
  const restoreMany = (ids: unknown, key?: string) =>
    api(t.app, tok).post(
      `/v1/vaults/${v}/trash/restore`,
      { file_ids: ids },
      key === undefined ? undefined : { 'idempotency-key': key }
    )
  const headSeq = async (): Promise<number> => (await get(`/v1/vaults/${v}/state`)).body.head_seq

  /** Files created and deleted, their ids in order. */
  async function trashed(names: string[]): Promise<string[]> {
    const ids: string[] = []
    for (const name of names) {
      await putBlob(tok, name)
      const r = (await commit(tok, [create(name, name)])).results[0]
      await commit(tok, [{ op: 'delete', file_id: r.file_id, base_version_id: r.version_id }])
      ids.push(r.file_id)
    }
    return ids
  }

  it('brings back three trashed files in one commit, one seq after another', async () => {
    const ids = await trashed(['bulk-a.md', 'bulk-b.md', 'bulk-c.md'])
    const before = await headSeq()
    const res = await restoreMany(ids)
    expect(res.status).toBe(200)
    CommitResponseSchema.parse(res.body)
    expect(res.body.head_seq).toBe(before + 3)
    expect(res.body.results.map((r: any) => [r.status, r.file_id, r.path])).toEqual([
      ['applied', ids[0], 'bulk-a.md'],
      ['applied', ids[1], 'bulk-b.md'],
      ['applied', ids[2], 'bulk-c.md'],
    ])
    expect(res.body.results.map((r: any) => r.seq)).toEqual([before + 1, before + 2, before + 3])
    const feed = (await get(`/v1/vaults/${v}/changes?since=${before}`)).body.items
    expect(feed.map((item: any) => item.op)).toEqual(['restore', 'restore', 'restore'])
    expect((await get(`/v1/vaults/${v}/trash?path_prefix=bulk-`)).body).toEqual([])
  })

  it('answers not_found for a file that is not in the trash, and restores the rest', async () => {
    const [gone] = await trashed(['bulk-gone.md'])
    await putBlob(tok, 'bulk-live')
    const live = (await commit(tok, [create('bulk-live.md', 'bulk-live')])).results[0].file_id
    const before = await headSeq()
    const res = await restoreMany([live, gone])
    expect(res.status).toBe(200)
    expect(res.body.results[0]).toMatchObject({ status: 'rejected', code: 'not_found' })
    expect(res.body.results[1]).toMatchObject({ status: 'applied', file_id: gone })
    expect(res.body.head_seq).toBe(before + 1)
    expect((await get(`/v1/vaults/${v}/files/${live}/versions`)).body).toHaveLength(1)
  })

  it('brings a file back under the next free name when its own is taken', async () => {
    const [old] = await trashed(['bulk-taken.md'])
    await putBlob(tok, 'the new one')
    await commit(tok, [create('bulk-taken.md', 'the new one')])
    const res = await restoreMany([old])
    expect(res.body.results[0]).toMatchObject({
      status: 'applied',
      file_id: old,
      path: 'bulk-taken 1.md',
    })
  })

  it('takes 1 to 1000 distinct ids and refuses anything else', async () => {
    const many = Array.from({ length: 1001 }, (_, k) => `id-${k}`)
    expect((await restoreMany(many)).status).toBe(400)
    expect((await restoreMany([])).status).toBe(400)
    const [one] = await trashed(['bulk-twice.md'])
    expect((await restoreMany([one, one])).status).toBe(400)
    expect((await restoreMany('nope')).status).toBe(400)
  })

  it('answers a retry with the same key as it did the first time, and writes nothing more', async () => {
    const ids = await trashed(['bulk-retry-a.md', 'bulk-retry-b.md'])
    const first = await restoreMany(ids, 'bulk-retry-key')
    const seq = await headSeq()
    const again = await restoreMany(ids, 'bulk-retry-key')
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await headSeq()).toBe(seq)
  })

  it('is refused for another vault', async () => {
    const res = await api(t.app, otherTok).post(`/v1/vaults/${v}/trash/restore`, {
      file_ids: ['x'],
    })
    expect(res.status).toBe(403)
  })
})
