import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { uptime } from 'node:os'
import { decodeAccessToken } from '@abele/sync-protocol'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { cleanupFolders, folder, SETUP_MS } from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { stateDbFile } from '../../src/vault.js'

const execute = promisify(execFile)
let server: SpawnedServer
const program = resolve('packages/cli/dist/index.js')
// The managed macOS sandbox denies the boot-time syscall. Supply only this host
// primitive in subprocess fixtures; the production lock implementation stays intact.
const boot = Date.now() - 60_000
const preload: string[] = []
try {
  uptime()
} catch {
  const source = `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.uptime = () => (Date.now() - ${boot}) / 1000; syncBuiltinESMExports();`
  preload.push('--import', 'data:text/javascript,' + encodeURIComponent(source))
}
async function cli(...args: string[]) {
  const result = await execute(process.execPath, [...preload, program, ...args], {
    timeout: 30_000,
  })
  return result.stdout
}
beforeAll(async () => {
  server = await spawnServer()
}, SETUP_MS)
afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

it('exchanges NFD paths through the built CLI across restarts, history, restore and deletes', async () => {
  const a = await folder(),
    b = await folder()
  await cli('connect', '--dir', a, '--token', server.tokenFor('NFD subprocess', 'A'))
  await cli('connect', '--dir', b, '--token', server.tokenFor('NFD subprocess', 'B'))
  const parent = 'Sample/й-folder'.normalize('NFD')
  const note = parent + '/' + 'ё-note.md'.normalize('NFD')
  await mkdir(join(a, parent, 'ё-empty'.normalize('NFD')), { recursive: true })
  await writeFile(join(a, note), 'first\n')
  const settle = async () => {
    for (const dir of [a, b, a, b]) await cli('run', '--dir', dir, '--once')
  }
  await settle()
  expect(await readFile(join(b, note.normalize('NFC')), 'utf8')).toBe('first\n')
  await writeFile(join(a, note), 'second\n')
  await settle()
  expect(await readFile(join(b, note.normalize('NFC')), 'utf8')).toBe('second\n')
  const history = await cli('history', note, '--dir', a)
  expect(history).toContain('#2')
  const first = history
    .split('\n')
    .find((line) => line.includes('#1'))!
    .trim()
    .split(/\s+/)[0]!
  await cli('restore', note.normalize('NFC'), '--dir', a, '--version', first)
  await settle()
  expect(await readFile(join(a, note), 'utf8')).toBe('first\n')
  await writeFile(join(b, parent.normalize('NFC'), 'й-new.md'), 'remote\n')
  await settle()
  expect(await readFile(join(a, parent, 'й-new.md'), 'utf8')).toBe('remote\n')
  const before = await cli('history', note, '--dir', a)
  // Rename only the leaf: on a sensitive disk the NFC parent does not exist.
  await rename(join(a, note), join(a, parent, 'ё-note.md'))
  await settle()
  expect(await cli('history', note, '--dir', a)).toBe(before)
  const movedParent = 'Sample/ё-renamed'.normalize('NFD')
  await rename(join(a, parent), join(a, movedParent))
  await settle()
  const movedNote = movedParent + '/' + 'й-renamed.md'.normalize('NFD')
  await rename(join(a, movedParent, 'ё-note.md'), join(a, movedNote))
  await settle()
  expect(await cli('history', movedNote, '--dir', a)).toContain(first)
  await writeFile(join(a, movedNote), 'first concurrent\ntail\n')
  await writeFile(join(b, movedNote.normalize('NFC')), 'second concurrent\ntail\n')
  await settle()
  const variants: string[] = []
  for (const name of await readdir(join(a, movedParent)))
    if (name.endsWith('.md')) variants.push(await readFile(join(a, movedParent, name), 'utf8'))
  expect(variants).toContain('first concurrent\ntail\n')
  expect(variants).toContain('second concurrent\ntail\n')
  await rm(join(b, movedParent.normalize('NFC'), 'й-new.md'))
  await settle()
  expect(await readdir(join(a, movedParent))).not.toContain('й-new.md')
  await rm(join(b, movedNote.normalize('NFC')))
  await settle()
  await cli('restore', movedNote, '--dir', a, '--deleted')
  await settle()
  const settled = await cli('history', movedNote, '--dir', a)
  await settle()
  await settle()
  expect(await cli('history', movedNote, '--dir', a)).toBe(settled)
  const status = JSON.parse(await cli('status', '--dir', a, '--json'))
  expect(status).toMatchObject({ pending: 0, collisions: [] })
  expect(await cli('status', '--dir', b)).toContain('pending    0')
}, 90_000)

it.each([true, false])(
  'joins existing NFC/NFD CLI work without losing either copy (equal: %s)',
  async (equal) => {
    const a = await folder(),
      b = await folder()
    const space = `NFD initial join ${equal}`
    await cli('connect', '--dir', a, '--token', server.tokenFor(space, 'A'))
    await cli('connect', '--dir', b, '--token', server.tokenFor(space, 'B'))
    const path = 'й-folder/ё-note.md'
    await mkdir(join(a, 'й-folder'.normalize('NFD')))
    await mkdir(join(b, 'й-folder'))
    await writeFile(join(a, path.normalize('NFD')), 'first\ntail\n')
    await writeFile(join(b, path), equal ? 'first\ntail\n' : 'second\ntail\n')
    for (const dir of [a, b, a, b, a, b]) await cli('run', '--dir', dir, '--once')
    const contents: string[] = []
    for (const name of await readdir(join(a, 'й-folder'.normalize('NFD'))))
      contents.push(await readFile(join(a, 'й-folder'.normalize('NFD'), name), 'utf8'))
    expect(contents).toContain('first\ntail\n')
    if (equal) expect(contents).toHaveLength(1)
    else expect(contents).toContain('second\ntail\n')
  },
  90_000
)

it('probes real twins and reports persistent collisions through plain and JSON CLI status', async (ctx) => {
  const a = await folder()
  const composed = 'й.md',
    decomposed = composed.normalize('NFD')
  await writeFile(join(a, composed), 'winner')
  let sensitive = true
  try {
    await writeFile(join(a, decomposed), 'loser', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') sensitive = false
    else throw error
  }
  if (!sensitive) {
    expect(
      process.env.ABELE_REQUIRE_NORMALIZATION_SENSITIVE,
      'Linux collision CI must support real normalization twins'
    ).not.toBe('1')
    ctx.skip()
  }
  await cli('connect', '--dir', a, '--token', server.tokenFor('NFD twins subprocess', 'A'))
  expect(await cli('run', '--dir', a, '--once')).toContain('sync: partial')
  expect(await cli('status', '--dir', a)).toMatch(/normalization collision.*U\+/)
  expect(JSON.parse(await cli('status', '--dir', a, '--json')).collisions).toHaveLength(1)
  // The ordinal winner is NFD; deleting it must never promote the known NFC loser.
  await rm(join(a, decomposed))
  expect(await cli('run', '--dir', a, '--once')).toContain('sync: partial')
  expect(await readFile(join(a, composed), 'utf8')).toBe('winner')
}, 90_000)

it('holds disjoint directory twins while unrelated CLI files converge on sensitive hosts', async (ctx) => {
  const a = await folder(),
    b = await folder()
  const nfc = 'й',
    nfd = nfc.normalize('NFD')
  await mkdir(join(a, nfc))
  let sensitive = true
  try {
    await mkdir(join(a, nfd))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') sensitive = false
    else throw error
  }
  if (!sensitive) {
    expect(process.env.ABELE_REQUIRE_NORMALIZATION_SENSITIVE).not.toBe('1')
    ctx.skip()
  }
  await writeFile(join(a, nfc, 'one.md'), 'one')
  await writeFile(join(a, nfd, 'two.md'), 'two')
  await writeFile(join(a, 'safe.md'), 'safe')
  const token = server.tokenFor('NFD directories subprocess', 'B')
  await cli('connect', '--dir', b, '--token', token)
  await mkdir(join(b, nfc))
  await writeFile(join(b, nfc, 'remote.md'), 'remote')
  await cli('run', '--dir', b, '--once')
  await cli('connect', '--dir', a, '--token', server.tokenFor('NFD directories subprocess', 'A'))
  expect(await cli('run', '--dir', a, '--once')).toContain('sync: partial')
  await cli('run', '--dir', b, '--once')
  expect(await readFile(join(b, 'safe.md'), 'utf8')).toBe('safe')
  expect(await readdir(join(a, nfc))).toEqual(['one.md'])
  expect(await readdir(join(a, nfd))).toEqual(['two.md'])
  const response = await fetch(server.url + '/v2/manifest', {
    headers: { authorization: 'Bearer ' + decodeAccessToken(token).key },
  })
  const manifest = (await response.json()) as { items: Array<{ path: string }> }
  expect(manifest.items.map((item) => item.path).sort()).toEqual(['safe.md', 'й', 'й/remote.md'])
}, 90_000)

it('recovers an old raw-NFD pending directory rejection in a restarted built CLI', async () => {
  const a = await folder()
  await cli('connect', '--dir', a, '--token', server.tokenFor('NFD pending subprocess', 'A'))
  const raw = 'й-folder'.normalize('NFD')
  await mkdir(join(a, raw))
  const stat = await lstat(join(a, raw))
  const state = SqliteStateStore.open(stateDbFile(a))
  try {
    await state.setMeta(
      'v2-directories',
      JSON.stringify({
        directories: [],
        removals: [],
        pending: {
          key: 'old-nfd-directory-key',
          identity: `${stat.dev}:${stat.ino}`,
          op: { op: 'mkdir', path: raw, mtime: 1 },
        },
      })
    )
  } finally {
    state.close()
  }
  for (let round = 0; round < 3; round++) await cli('run', '--dir', a, '--once')
  const recovered = SqliteStateStore.openReadOnlySnapshot(stateDbFile(a))
  try {
    const doc = JSON.parse((await recovered.getMeta('v2-directories'))!)
    expect(doc.pending).toBeUndefined()
    expect(doc.directories).toHaveLength(1)
    expect(doc.directories[0]).toMatchObject({ path: 'й-folder', localPath: raw })
  } finally {
    recovered.close()
  }
}, 90_000)
