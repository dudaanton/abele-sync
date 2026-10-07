import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { api, type Res } from '../helpers/client.js'
import { create, putBlob as put } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

const HOUR_MS = 60 * 60 * 1000

/** A POST, under an idempotency key when the caller names one. */
const post = (
  app: FastifyInstance,
  token: string,
  url: string,
  body?: unknown,
  key?: string
): Promise<Res> =>
  api(app, token).post(url, body, key === undefined ? undefined : { 'idempotency-key': key })

/** Whether the server said it had answered this one before. */
const replayed = (res: Res): string | string[] | undefined => res.headers['idempotent-replayed']

/** A file written twice in `vault`: its id and the id of its first version, to restore. */
async function twoVersions(
  t: TestApp,
  device: string,
  vault: string,
  path: string
): Promise<{ fileId: string; firstId: string }> {
  await put(t.app, device, `${path} one\n`)
  await put(t.app, device, `${path} two\n`)
  const url = `/v1/vaults/${vault}/commit`
  const one = await post(t.app, device, url, { ops: [create(path, `${path} one\n`)] })
  const made = one.body.results[0]
  await post(t.app, device, url, {
    ops: [
      {
        ...create(path, `${path} two\n`, 2),
        op: 'modify',
        path: undefined,
        file_id: made.file_id,
        base_version_id: made.version_id,
      },
    ],
  })
  return { fileId: made.file_id as string, firstId: made.version_id as string }
}

describe('idempotency keys', () => {
  let t: TestApp
  let v: string
  let tok: string
  let tok2: string
  let accountToken: string

  const commit = (token: string, body: unknown, key?: string): Promise<Res> =>
    post(t.app, token, `/v1/vaults/${v}/commit`, body, key)
  const feed = (): Promise<Res> => api(t.app, tok).get(`/v1/vaults/${v}/changes?since=0`)

  beforeAll(async () => {
    t = await buildTestApp()
    accountToken = (await t.account()).accountToken
    v = (await t.vault(accountToken)).vaultId
    tok = (await t.device(accountToken, v, 'laptop')).deviceToken
    tok2 = (await t.device(accountToken, v, 'phone')).deviceToken
  })
  afterAll(async () => {
    await t.close()
  })

  it('replays the first answer to a repeated commit and writes only one version', async () => {
    await put(t.app, tok, 'one\n')
    const body = { ops: [create('One.md', 'one\n')] }
    const first = await commit(tok, body, 'k-one')
    expect(first.status).toBe(200)
    expect(first.body.results[0]).toMatchObject({ status: 'applied', path: 'One.md' })
    expect(replayed(first)).toBeUndefined()

    const again = await commit(tok, body, 'k-one')
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(replayed(again)).toBe('true')

    // The batch was applied once, whatever the client asked twice.
    const changes = await feed()
    expect(changes.body.items).toHaveLength(1)
    expect(changes.body.head_seq).toBe(1)
  })

  it('refuses the same key used for a different request', async () => {
    await put(t.app, tok, 'other\n')
    const r = await commit(tok, { ops: [create('Other.md', 'other\n')] }, 'k-one')
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('idempotency_mismatch')
    // A refused request writes nothing of its own, and leaves the entry it clashed with.
    expect((await feed()).body.items).toHaveLength(1)
    const kept = await commit(tok, { ops: [create('One.md', 'one\n')] }, 'k-one')
    expect(replayed(kept)).toBe('true')
  })

  it('gives every device keys of its own', async () => {
    await put(t.app, tok2, 'two\n')
    const body = { ops: [create('Two.md', 'two\n')] }
    const other = await commit(tok2, body, 'k-one')
    expect(other.status).toBe(200)
    expect(other.body.results[0]).toMatchObject({ status: 'applied', path: 'Two.md' })
    expect(replayed(other)).toBeUndefined()

    const twice = await commit(tok2, body, 'k-one')
    expect(replayed(twice)).toBe('true')
    expect(twice.body).toEqual(other.body)
  })

  it('replays a restore, from history and from the trash alike', async () => {
    await put(t.app, tok, 'v1\n')
    const made = await commit(tok, { ops: [create('R.md', 'v1\n')] })
    const file = made.body.results[0].file_id
    const first = made.body.results[0].version_id
    const second = await put(t.app, tok, 'v2\n')
    await commit(tok, {
      ops: [
        { op: 'modify', file_id: file, base_version_id: first, sha: second, size: 3, mtime: 2 },
      ],
    })

    const url = `/v1/vaults/${v}/files/${file}/restore`
    const back = await post(t.app, tok, url, { version_id: first }, 'k-restore')
    expect(back.status).toBe(200)
    expect(back.body.status).toBe('applied')
    const backAgain = await post(t.app, tok, url, { version_id: first }, 'k-restore')
    expect(replayed(backAgain)).toBe('true')
    expect(backAgain.body).toEqual(back.body)
    // Two creates and one restore: the second call restored nothing again.
    const versions = await api(t.app, tok).get(`/v1/vaults/${v}/files/${file}/versions`)
    expect(versions.body).toHaveLength(3)

    // The same for the trash, whose restore carries no body at all.
    const head = versions.body[0].version_id
    await commit(tok, { ops: [{ op: 'delete', file_id: file, base_version_id: head }] })
    const trash = `/v1/vaults/${v}/trash/${file}/restore`
    const dug = await post(t.app, tok, trash, undefined, 'k-trash')
    expect(dug.status).toBe(200)
    const dugAgain = await post(t.app, tok, trash, undefined, 'k-trash')
    expect(replayed(dugAgain)).toBe('true')
    expect(dugAgain.body).toEqual(dug.body)
  })

  it('tells two bodiless requests apart by what they ask of what', async () => {
    await put(t.app, tok, 'a\n')
    await put(t.app, tok, 'b\n')
    const made = await commit(tok, {
      ops: [create('A.md', 'a\n'), create('B.md', 'b\n')],
    })
    const [a, b] = made.body.results
    await commit(tok, {
      ops: [
        { op: 'delete', file_id: a.file_id, base_version_id: a.version_id },
        { op: 'delete', file_id: b.file_id, base_version_id: b.version_id },
      ],
    })
    const trash = (file: string): string => `/v1/vaults/${v}/trash/${file}/restore`

    const first = await post(t.app, tok, trash(a.file_id), undefined, 'k-bodiless')
    expect(first.body).toMatchObject({ status: 'applied', path: 'A.md' })
    // The same key, no body either time, another file: not the first one's answer.
    const clash = await post(t.app, tok, trash(b.file_id), undefined, 'k-bodiless')
    expect(clash.status).toBe(422)
    expect(clash.body.error.code).toBe('idempotency_mismatch')

    // B.md stayed in the trash, and a key of its own brings it back.
    const back = await post(t.app, tok, trash(b.file_id), undefined, 'k-bodiless-two')
    expect(back.body).toMatchObject({ status: 'applied', path: 'B.md' })

    // And a key spent on a commit is not a key for a restore.
    await put(t.app, tok, 'c\n')
    await commit(tok, { ops: [create('C.md', 'c\n')] }, 'k-crossed')
    const crossed = await post(t.app, tok, trash(b.file_id), undefined, 'k-crossed')
    expect(crossed.status).toBe(422)
    expect(crossed.body.error.code).toBe('idempotency_mismatch')
  })

  it('pays no attention to a key on a route that is not idempotent', async () => {
    const one = await post(t.app, accountToken, '/v1/vaults', { name: 'K' }, 'k-vault')
    const two = await post(t.app, accountToken, '/v1/vaults', { name: 'K' }, 'k-vault')
    expect(one.status).toBe(201)
    expect(two.status).toBe(201)
    expect(two.body.id).not.toBe(one.body.id)
    expect(replayed(two)).toBeUndefined()
  })

  it('keeps a device receipt past the ttl so a delayed journal cannot resurrect a delete', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const aged = await buildTestApp({ now: () => clock })
    try {
      const account = (await aged.account()).accountToken
      const vault = (await aged.vault(account)).vaultId
      const device = (await aged.device(account, vault)).deviceToken
      const url = `/v1/vaults/${vault}/commit`
      await put(aged.app, device, 'ttl\n')
      const body = { ops: [create('Ttl.md', 'ttl\n')] }

      const first = await post(aged.app, device, url, body, 'k-ttl')
      expect(first.body).toMatchObject({ head_seq: 1, results: [{ status: 'applied' }] })
      // The file goes, so a create that runs again is plain to see in the feed.
      const { file_id, version_id } = first.body.results[0]
      await post(aged.app, device, url, {
        ops: [{ op: 'delete', file_id, base_version_id: version_id }],
      })

      clock = new Date(clock.getTime() + 25 * HOUR_MS)
      const stale = await post(aged.app, device, url, body, 'k-ttl')
      expect(replayed(stale)).toBe('true')
      expect(stale.body).toEqual(first.body)
      expect(await aged.db.selectFrom('versions').select('id').execute()).toHaveLength(2)
    } finally {
      await aged.close()
    }
  })

  it('files no refusal: a request refused under a key runs again, and lands once mended', async () => {
    const url = `/v1/vaults/${v}/commit`
    // An empty batch is refused at the door, before any op runs.
    const refused = await post(t.app, tok, url, { ops: [] }, 'k-refused')
    expect(refused.status).toBe(400)
    expect(refused.body.error.code).toBe('invalid_request')
    const again = await post(t.app, tok, url, { ops: [] }, 'k-refused')
    expect(again.status).toBe(400)
    expect(replayed(again)).toBeUndefined()

    // Mended, under the same key: there is no entry to clash with, so it runs and lands.
    await put(t.app, tok, 'mended\n')
    const body = { ops: [create('Mended.md', 'mended\n')] }
    const mended = await post(t.app, tok, url, body, 'k-refused')
    expect(mended.status).toBe(200)
    expect(replayed(mended)).toBeUndefined()
    expect(mended.body.results[0]).toMatchObject({ status: 'applied', path: 'Mended.md' })
    // And the success is what the key now answers with.
    const filed = await post(t.app, tok, url, body, 'k-refused')
    expect(replayed(filed)).toBe('true')
    expect(filed.body).toEqual(mended.body)
  })

  it('stores nothing when the server broke, so the retry gets a real answer', async () => {
    const broken = (await t.vault(accountToken, 'Broken')).vaultId
    const device = (await t.device(accountToken, broken, 'brave')).deviceToken
    const url = `/v1/vaults/${broken}/commit`
    // Uploaded while the vault can still be read: an upload counts against its settings too.
    await put(t.app, device, 'boom\n')
    const settings = await t.db
      .selectFrom('vaults')
      .select('settings')
      .where('id', '=', broken)
      .executeTakeFirstOrThrow()
    // Settings no parser can read: the commit fails as the server's own fault.
    await t.db
      .updateTable('vaults')
      .set({ settings: '{not json' })
      .where('id', '=', broken)
      .execute()

    const body = { ops: [create('Boom.md', 'boom\n')] }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await post(t.app, device, url, body, 'k-500')).status).toBe(500)
    } finally {
      logged.mockRestore()
    }

    await t.db
      .updateTable('vaults')
      .set({ settings: settings.settings })
      .where('id', '=', broken)
      .execute()
    const healed = await post(t.app, device, url, body, 'k-500')
    expect(healed.status).toBe(200)
    expect(replayed(healed)).toBeUndefined()
    expect(healed.body.results[0]).toMatchObject({ status: 'applied', path: 'Boom.md' })
  })

  it('answers two requests under one key sent at once with one run and one answer', async () => {
    const raced = (await t.vault(accountToken, 'Raced')).vaultId
    const device = (await t.device(accountToken, raced, 'eager')).deviceToken
    const { fileId, firstId } = await twoVersions(t, device, raced, 'Twice.md')
    const url = `/v1/vaults/${raced}/files/${fileId}/restore`
    const body = { version_id: firstId }
    // A client that timed out and retried while the first request was still running. A restore
    // run twice writes two versions, so only one run may happen.
    const [first, second] = await Promise.all([
      post(t.app, device, url, body, 'k-race'),
      post(t.app, device, url, body, 'k-race'),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)
    const changes = await api(t.app, device).get(`/v1/vaults/${raced}/changes?since=0`)
    expect(changes.body.items).toHaveLength(3)
  })

  it('files the answer with the commit, so an answer lost on the way out is still replayed', async () => {
    const lost = (await t.vault(accountToken, 'Lost')).vaultId
    const device = (await t.device(accountToken, lost, 'unlucky')).deviceToken
    const { fileId, firstId } = await twoVersions(t, device, lost, 'Lost.md')
    const url = `/v1/vaults/${lost}/files/${fileId}/restore`
    const body = { version_id: firstId }
    // Anything that would file the answer after the commit's own transaction fails, as a
    // process killed between the two would leave it.
    const insertInto = t.db.insertInto.bind(t.db)
    const broken = vi.spyOn(t.db, 'insertInto').mockImplementation(((table: string) => {
      if (table === 'idempotency') throw new Error('the process died here')
      return insertInto(table as never)
    }) as typeof t.db.insertInto)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    let first: Res
    try {
      first = await post(t.app, device, url, body, 'k-lost')
    } finally {
      broken.mockRestore()
      logged.mockRestore()
    }
    expect(first.status).toBe(200)
    const again = await post(t.app, device, url, body, 'k-lost')
    expect(replayed(again)).toBe('true')
    expect(again.body).toEqual(first.body)
    const changes = await api(t.app, device).get(`/v1/vaults/${lost}/changes?since=0`)
    expect(changes.body.items).toHaveLength(3)
  })
})
