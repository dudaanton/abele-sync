import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  encodeText,
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  push,
  scan,
  sha256,
  type ScanFilter,
} from '../../src/index.js'
import { BASE_URL, serverHarness, type Harness } from '../helpers/harness.js'
import { seed } from '../helpers/seed.js'

/**
 * A push whose answers name many large heads holds no more of their bytes at once than the
 * same budget the pull keeps to (`prefetchBytes`), one head bigger than it alone.
 */

const ALL: ScanFilter = { excluded: () => false }
const decoder = new TextDecoder()

let h: Harness
let accountToken: string

beforeAll(async () => {
  h = await serverHarness()
  accountToken = (await h.account('push-budget@abele.test')).accountToken
})
afterAll(async () => {
  await h.close()
})

it('holds no more of a batch’s downloaded heads at once than its budget, a head bigger than it alone', async () => {
  const { vaultId } = await h.vault(accountToken, 'budget')
  const { deviceToken } = await h.device(accountToken, vaultId, 'mine')
  const { deviceToken: theirs } = await h.device(accountToken, vaultId, 'theirs')
  // Conflicts copied aside, so every answer names the other device's whole head to write back.
  const settings = await h.fetch(`${BASE_URL}/v1/vaults/${vaultId}/settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conflict: 'conflict-file' }),
  })
  expect(settings.status).toBe(200)

  const client = h.clientFor(deviceToken, vaultId)
  const other = h.clientFor(theirs, vaultId)
  const fs = new MemoryFileSystem()
  const state = new MemoryStateStore()
  const expected = new ExpectedWrites()
  const names = Array.from({ length: 10 }, (_, i) => `notes/${i}.md`).concat('notes/huge.md')
  for (const name of names) await fs.writeAtomic(name, encodeText(`first ${name}`), 1000)
  let keys = 0
  const sync = async (prefetchBytes?: number) =>
    push(client, fs, state, await scan(fs, state, ALL), {
      expected,
      keys: () => `budget-${++keys}`,
      ...(prefetchBytes === undefined ? {} : { prefetchBytes }),
    })
  await sync()

  // The other device edits every file with a large head; this one edits every file too.
  const heads = new Map<string, string>()
  const ops = []
  for (const [i, name] of names.entries()) {
    const text = name.endsWith('huge.md') ? 'h'.repeat(150_000) : String(i).repeat(40_000)
    heads.set(name, text)
    const bytes = encodeText(text)
    const sha = await sha256(bytes)
    await other.putBlob(sha, bytes)
    const entry = await state.get(name)
    if (entry === null) throw new Error(`${name} was never synced`)
    ops.push({
      op: 'modify' as const,
      file_id: entry.fileId,
      base_version_id: entry.versionId,
      sha,
      size: bytes.length,
      mtime: 2000,
    })
  }
  await seed(other, ops)
  for (const name of names) await fs.writeAtomic(name, encodeText(`mine ${name}`), 3000)

  // Heads downloaded and not yet written, at the moment of each write.
  let gets = 0
  let writes = 0
  let peak = 0
  const getBlob = client.getBlob.bind(client)
  client.getBlob = async (sha) => {
    gets++
    return getBlob(sha)
  }
  const write = fs.writeAtomic.bind(fs)
  fs.writeAtomic = async (path, bytes, mtime) => {
    peak = Math.max(peak, gets - writes)
    writes++
    await write(path, bytes, mtime)
  }
  const report = await sync(100_000)

  expect(report).toMatchObject({ conflicts: 11, rejected: [] })
  expect(gets).toBe(11)
  for (const [name, text] of heads) expect(decoder.decode(await fs.read(name))).toBe(text)
  expect(await state.getJournal()).toBeNull()
  // Two 40 kB heads fit the 100 kB budget; a third would not.
  expect(peak).toBeLessThanOrEqual(2)
})
