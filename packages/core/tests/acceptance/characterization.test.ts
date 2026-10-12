import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, converge } from '../helpers/device.js'

/** Decided offline policies, exercised against the retained single-server engine. */
const received = new Date('2026-10-10T00:00:00Z')
let harness: Harness
beforeAll(async () => {
  harness = await serverHarness({ now: () => received })
})
afterAll(async () => {
  await harness.close()
})
async function pair() {
  const account = (await harness.account()).accountToken
  const vault = (await harness.vault(account)).vaultId
  const aToken = (await harness.device(account, vault, 'A')).deviceToken
  const bToken = (await harness.device(account, vault, 'B')).deviceToken
  return {
    a: new Device(harness, vault, aToken, 'A'),
    b: new Device(harness, vault, bToken, 'B'),
    vault,
  }
}
describe('108–110 decided offline policies (retained engine)', () => {
  it('108 stale edits merge normally by lines', async () => {
    const { a, b } = await pair()
    await a.write('Note.md', 'one\ntwo\n')
    await converge(a, b)
    await a.write('Note.md', 'ONE\ntwo\n')
    await a.sync()
    await b.write('Note.md', 'one\nTWO\n')
    await converge(b, a)
    expect(await a.text('Note.md')).toBe('ONE\nTWO\n')
    expect(a.paths()).toEqual(['Note.md'])
  })
  it('109 edit beats delete; an offline edit resurrects the file', async () => {
    const { a, b } = await pair()
    await a.write('Note.md', 'before\n')
    await converge(a, b)
    await a.rm('Note.md')
    await a.sync()
    await b.write('Note.md', 'offline edit\n')
    await converge(b, a)
    expect(await a.text('Note.md')).toBe('offline edit\n')
    expect(await b.text('Note.md')).toBe('offline edit\n')
  })
  it('110 original authored mtime survives transport (receipt audit is not a sync mtime)', async () => {
    const { a, b } = await pair()
    const authored = Date.parse('2026-09-01T00:00:00Z')
    await a.write('Note.md', 'old edit\n', authored)
    await converge(a, b)
    const entry = await a.state.get('Note.md')
    const history = await a.client.versions(entry!.fileId)
    expect(history[0]!.mtime).toBe(authored)
    expect(history[0]!.at).toBe(received.toISOString())
    const version = await harness.db
      .selectFrom('versions')
      .select(['mtime', 'created_at'])
      .where('id', '=', entry!.versionId)
      .executeTakeFirstOrThrow()
    expect(version).toEqual({ mtime: authored, created_at: received.toISOString() })
  })
  it('110 merge mtime is latest original edit, never server now', async () => {
    const { a, b } = await pair()
    await a.write('Note.md', 'one\ntwo\n', 1000)
    await converge(a, b)
    await a.write('Note.md', 'ONE\ntwo\n', 2000)
    await a.sync()
    await b.write('Note.md', 'one\nTWO\n', 3000)
    await converge(b, a)
    const entry = await a.state.get('Note.md')
    expect((await a.client.versions(entry!.fileId))[0]!.mtime).toBe(3000)
  })
})
