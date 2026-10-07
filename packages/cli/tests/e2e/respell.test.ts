import { existsSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupFolders,
  cli,
  converge,
  EMAIL,
  folder,
  listing,
  manifestPaths,
  PASSWORD,
  read,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
  type Pair,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * A rename that only changes case, or only the Unicode form of a name, on a disk that does not
 * tell those apart — macOS's by default. To such a disk the old name and the new one are the
 * same file, so anything that "cleans up the old name" after the move removes the only copy.
 */

let server: SpawnedServer
let pair: Pair
/** Whether this machine's temp folder folds case, which is the only place the bug lives. */
let folds = false

beforeAll(async () => {
  const probe = await folder()
  await writeFile(join(probe, 'Probe'), '')
  folds = existsSync(join(probe, 'PROBE'))
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  pair = await vaultPair(server, 'Respell')
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

describe('a rename to another spelling of the same name', () => {
  it('keeps the file, renamed, in both folders and on the server', async (ctx) => {
    if (!folds) ctx.skip()
    const { a, b } = pair
    await write(a, 'CaseTest.md', 'still here\n')
    await converge(a, b)

    await rename(join(a, 'CaseTest.md'), join(a, 'casetest.md'))
    await converge(a, b)

    expect(await listing(a)).toEqual(['casetest.md'])
    expect(await listing(b)).toEqual(['casetest.md'])
    expect(await read(b, 'casetest.md')).toBe('still here\n')
    expect(await manifestPaths(a)).toEqual(['casetest.md'])
  })

  it('keeps a file renamed to another case and another Unicode form', async (ctx) => {
    if (!folds) ctx.skip()
    const { a, b } = pair
    const before = 'Caf\u00e9.md'.normalize('NFC')
    const after = 'caf\u00e9.md'.normalize('NFD')
    await write(b, before, 'coffee\n')
    await converge(a, b)

    await rename(join(b, before), join(b, after))
    // Not `converge`: B keeps its own NFD spelling, which a byte-wise listing calls different.
    for (const dir of [a, b, a, b]) await syncOnce(dir)

    const wire = after.normalize('NFC')
    expect((await listing(a)).map((p) => p.normalize('NFC'))).toEqual([wire, 'casetest.md'])
    expect(await read(a, wire)).toBe('coffee\n')
    expect((await listing(b)).map((p) => p.normalize('NFC'))).toEqual([wire, 'casetest.md'])
    expect(await manifestPaths(a)).toEqual([wire, 'casetest.md'])
  })
})

describe('two spellings of one name on a disk that tells them apart', () => {
  it('holds the fresh one back, sends nothing for it, and says so in status', async (ctx) => {
    if (folds) ctx.skip()
    const { a } = pair
    await write(a, 'Twins/Image.png', 'the synced one')
    await syncOnce(a)
    const before = await manifestPaths(a)

    await write(a, 'Twins/image.png', 'a stranger')
    for (let round = 0; round < 3; round++) await syncOnce(a)

    expect(await manifestPaths(a)).toEqual(before)
    const status = await cli(['status', '--dir', a])
    const printed = status.out.join('\n')
    expect(printed).toContain('pending    0')
    expect(printed).toMatch(
      /held +Twins\/image\.png: Twins\/Image\.png is synced under the same name/
    )
  })
})
