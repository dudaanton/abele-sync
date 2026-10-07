import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api } from '../helpers/client.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { buildTestApp, TEST_PASSWORD, type TestApp } from '../helpers/testApp.js'

/**
 * A merge the server makes is bytes nobody sent, so the limits checked against what was sent
 * say nothing about it: two notes each within the file limit can merge into one over it, or
 * over the vault's quota. Such a merge is not written. Both sides are kept as they came — the
 * head where it is, the incoming text in a conflict copy beside it — and when the copy would
 * not fit the quota (as it usually will not where the merge did not), the incoming text is kept in
 * the file's history instead.
 */

const BASE = 'shared line\n'
const top = (n: number) => `${'T'.repeat(n)}\n${BASE}`
const bottom = (n: number) => `${BASE}${'B'.repeat(n)}\n`

describe('limits on a merged head', () => {
  let t: TestApp
  let tok: string
  let tok2: string
  let vaultId: string

  beforeEach(async () => {
    t = await buildTestApp()
    const { accountToken } = await t.account()
    vaultId = (await t.vault(accountToken)).vaultId
    tok = (await t.device(accountToken, vaultId, 'laptop')).deviceToken
    tok2 = (await t.device(accountToken, vaultId, 'phone')).deviceToken
  })
  afterEach(async () => {
    await t.close()
  })

  /** A note, edited at its top by one device and at its bottom by the other, from one base. */
  async function editBothEnds(n: number) {
    await putBlob(t.app, tok, BASE)
    const made = (await commit(t.app, tok, vaultId, [create('Note.md', BASE)])).results[0]
    const modify = (text: string) => ({
      op: 'modify',
      file_id: made.file_id,
      base_version_id: made.version_id,
      sha: shaOf(text),
      size: Buffer.byteLength(text),
      mtime: 5,
    })
    await putBlob(t.app, tok2, top(n))
    const first = (await commit(t.app, tok2, vaultId, [modify(top(n))])).results[0]
    expect(first.status).toBe('applied')
    await putBlob(t.app, tok, bottom(n))
    const second = (await commit(t.app, tok, vaultId, [modify(bottom(n))])).results[0]
    return { fileId: made.file_id as string, second }
  }

  const largest = async (): Promise<number> => {
    const rows = await t.db.selectFrom('versions').select('size').execute()
    return Math.max(...rows.map((row) => Number(row.size)))
  }

  const liveBytes = async (): Promise<number> =>
    (await api(t.app, tok).get(`/v1/vaults/${vaultId}/usage`)).body.live_bytes as number

  it('writes no merge over the file limit, and keeps the incoming text in a conflict copy', async () => {
    await api(t.app, tok).patch(`/v1/vaults/${vaultId}/settings`, { max_file_bytes: 100 })
    const { second } = await editBothEnds(80)
    expect(second).toMatchObject({ status: 'conflict', sha: shaOf(top(80)) })
    expect(await largest()).toBeLessThanOrEqual(100)
    const copy = await api(t.app, tok).raw({
      method: 'GET',
      url: `/v1/blobs/${shaOf(bottom(80))}`,
    })
    expect(copy.raw).toBe(bottom(80))
  })

  it('keeps the incoming text in history when a copy past the file limit would not fit the quota', async () => {
    await api(t.app, tok).patch(`/v1/vaults/${vaultId}/settings`, {
      max_file_bytes: 100,
      quota_bytes: 150,
      account_password: TEST_PASSWORD,
    })
    const { second } = await editBothEnds(80)
    expect(second).toMatchObject({ status: 'merged', sha: shaOf(top(80)) })
    expect(await largest()).toBeLessThanOrEqual(100)
    expect(await liveBytes()).toBeLessThanOrEqual(150)
  })

  it('writes no merge that would take the vault over its quota, and keeps the incoming text in history', async () => {
    // A merge holds both edits, so a copy of the incoming text beside the head never fits
    // where the merge did not: the incoming text goes into the file's history instead.
    await api(t.app, tok).patch(`/v1/vaults/${vaultId}/settings`, {
      quota_bytes: 160,
      account_password: TEST_PASSWORD,
    })
    const { fileId, second } = await editBothEnds(80)
    // The head stays what it was, and nothing new is live.
    expect(second).toMatchObject({ status: 'merged', sha: shaOf(top(80)) })
    expect(await liveBytes()).toBeLessThanOrEqual(160)
    expect(await liveBytes()).toBe(Buffer.byteLength(top(80)))
    const history = await api(t.app, tok).get(`/v1/vaults/${vaultId}/files/${fileId}/versions`)
    const shas = (history.body as Array<{ sha: string | null }>).map((v) => v.sha)
    expect(shas).toContain(shaOf(bottom(80)))
  })

  /** A note of exactly 90 bytes whose frontmatter says `title: <title>`. */
  const titled = (title: string) => {
    const head = `---\ntitle: ${title}\n---\n`
    return `${head}${'x'.repeat(90 - head.length - 1)}\n`
  }

  /** The base, then one device's title, then the other's sent against the same base. */
  async function retitle(conflict?: 'conflict-file') {
    if (conflict !== undefined) {
      await api(t.app, tok).patch(`/v1/vaults/${vaultId}/settings`, { conflict })
    }
    await putBlob(t.app, tok, titled('a'))
    const made = (await commit(t.app, tok, vaultId, [create('Note.md', titled('a'))])).results[0]
    await api(t.app, tok).patch(`/v1/vaults/${vaultId}/settings`, {
      quota_bytes: 150,
      account_password: TEST_PASSWORD,
    })
    const modify = (text: string) => ({
      op: 'modify',
      file_id: made.file_id,
      base_version_id: made.version_id,
      sha: shaOf(text),
      size: Buffer.byteLength(text),
      mtime: 5,
    })
    await putBlob(t.app, tok2, titled('b'))
    expect((await commit(t.app, tok2, vaultId, [modify(titled('b'))])).results[0].status).toBe(
      'applied'
    )
    await putBlob(t.app, tok, titled('c'))
    const second = (await commit(t.app, tok, vaultId, [modify(titled('c'))])).results[0]
    return { fileId: made.file_id as string, second }
  }

  it('keeps the incoming text in history when a merge that breaks the frontmatter leaves no room for a copy', async () => {
    const { fileId, second } = await retitle()
    // Both titles in one frontmatter is no YAML; a copy of 90 bytes beside a head of 90 is 180.
    expect(second).toMatchObject({ status: 'merged', sha: shaOf(titled('b')) })
    expect(await liveBytes()).toBeLessThanOrEqual(150)
    const history = await api(t.app, tok).get(`/v1/vaults/${vaultId}/files/${fileId}/versions`)
    const shas = (history.body as Array<{ sha: string | null }>).map((v) => v.sha)
    expect(shas).toContain(shaOf(titled('c')))
  })

  it('makes no conflict copy the quota has no room for in a vault that copies conflicts aside', async () => {
    const { fileId, second } = await retitle('conflict-file')
    expect(second).toMatchObject({ status: 'merged', sha: shaOf(titled('b')) })
    expect(await liveBytes()).toBeLessThanOrEqual(150)
    const history = await api(t.app, tok).get(`/v1/vaults/${vaultId}/files/${fileId}/versions`)
    const shas = (history.body as Array<{ sha: string | null }>).map((v) => v.sha)
    expect(shas).toContain(shaOf(titled('c')))
  })
})
