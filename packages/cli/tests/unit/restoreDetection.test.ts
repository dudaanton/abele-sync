import { afterEach, expect, it } from 'vitest'
import { mkdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  MemoryStateStore,
  SyncEngine,
  V2EngineClient,
  encodeText,
  selectiveDefaults,
  readReconciliation,
} from '@abele/sync-core'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server, type V2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { localCodeChanges } from '../../src/codeCheck.js'
import { codeGroups } from '../../src/pluginCode.js'
import { NodeFileSystem } from '../../src/nodeFs.js'

let server: V2Server | undefined
let scratch: string | undefined
const engines: SyncEngine[] = []
const main = '.obsidian/plugins/example/main.js'
it.each(['Note.bin', 'Café/Note.bin'.normalize('NFD')])(
  'preserves a causally newer remote binary with a clock behind backdated local bytes: %s',
  async (path) => {
    const { a, owner } = await fixture()
    await a.fs.writeAtomic(path, encodeText('base'), 100)
    await a.restart().sync()
    const entry = (await a.state.get(path))!
    const blob = await owner.upload(Buffer.from('causally newer remote'))
    await owner.commit([
      { op: 'modify', file_id: entry.fileId, base_version_id: entry.versionId, ...blob, mtime: 0 },
    ])
    await a.fs.writeAtomic(path, encodeText('restored edit'), 1)
    await a.restart().sync()
    const items = (await owner.manifest()).items.filter((item) => item.kind !== 'directory')
    const remote = await Promise.all(
      items.map(async (item) => (await owner.content(item.file_id)).toString())
    )
    expect(remote.sort()).toEqual(['causally newer remote', 'restored edit'])
    const local = await Promise.all(
      items.map(async (item) => Buffer.from(await a.fs.read(item.path)).toString())
    )
    expect(local.sort()).toEqual(['causally newer remote', 'restored edit'])
    await a.restart().sync()
    expect((await owner.manifest()).items.filter((item) => item.kind !== 'directory')).toHaveLength(
      2
    )
  }
)
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.stop()
  await server?.close()
  server = undefined
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})
async function fixture() {
  server = await v2Server()
  await mkdir(resolve('.scratch'), { recursive: true })
  scratch = await mkdtemp(join(resolve('.scratch'), 'restore-unit-'))
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper, dialect: 'sqlite' },
    'Detection fixture',
    server.address
  )
  let devices = 0
  const device = () => {
    const path = join(scratch!, `device-${++devices}`)
    mkdirSync(path)
    const fs = new NodeFileSystem(path, { skipHidden: true }),
      state = new MemoryStateStore()
    const restart = () => {
      const engine = new SyncEngine({
        fs,
        state,
        client: new V2EngineClient(root.token, { fetch }),
        selective: selectiveDefaults(),
        defer: (path) => path.startsWith('.obsidian/plugins/'),
      })
      engines.push(engine)
      return engine
    }
    return { fs, state, restart, path }
  }
  return { a: device(), b: device(), owner: new V2SyncClient(root.token) }
}
it('settles a losing plugin delete on restart so code approval accepts the already settled absence', async () => {
  const { a, b } = await fixture()
  await a.fs.writeAtomic(main, encodeText('before()'), 100)
  await a.restart().sync()
  const first = b.restart()
  await first.sync()
  await first.applyDeferred()
  expect(await b.fs.read(main)).toEqual(encodeText('before()'))
  await unlink(join(b.path, main))
  await a.fs.writeAtomic(main, encodeText('after()'), 200)
  await a.restart().sync()
  const restarted = b.restart()
  const report = await restarted.sync()
  expect(report.push.merged, JSON.stringify(report.push)).toBe(1)
  expect(await b.fs.stat(main)).toBeNull()
  expect(await readReconciliation(b.state)).toBeNull()
  const groups = codeGroups(await restarted.deferred())
  expect(groups).toHaveLength(1)
  expect(
    await localCodeChanges(groups[0]!, {
      fs: b.fs,
      state: b.state,
      filter: { excluded: () => false },
    })
  ).toEqual([])
  expect((await restarted.applyDeferred()).applied).toEqual([main])
  expect(await b.fs.read(main)).toEqual(encodeText('after()'))
})
it('stages a remote plugin move with a local edit without entering restore reconciliation', async () => {
  const { a, b, owner } = await fixture()
  await a.fs.writeAtomic(main, encodeText('before()'), 100)
  await a.restart().sync()
  const first = b.restart()
  await first.sync()
  await first.applyDeferred()
  const entry = (await b.state.get(main))!
  const target = '.obsidian/plugins/moved/main.js'
  await owner.commit([
    { op: 'move', file_id: entry.fileId, base_version_id: entry.versionId, to_path: target },
  ])
  await b.fs.writeAtomic(main, encodeText('local()'), 200)
  const restarted = b.restart()
  await restarted.sync()
  expect(await readReconciliation(b.state)).toBeNull()
  expect(await b.fs.read(main)).toEqual(encodeText('local()'))
  expect(await b.fs.stat(target)).toBeNull()
  expect(await restarted.deferred()).toContainEqual(
    expect.objectContaining({ path: target, prev_path: main })
  )
})
it('keeps ordinary backdated attachment races on newer-wins without an extra recovery copy', async () => {
  const { a, b, owner } = await fixture()
  const path = 'pic.bin'
  await a.fs.writeAtomic(path, encodeText('base'), 100)
  await a.restart().sync()
  await b.restart().sync()
  await b.fs.writeAtomic(path, encodeText('older edit'), 1)
  await a.fs.writeAtomic(path, encodeText('newer edit'), 200)
  await a.restart().sync()
  await b.restart().sync()
  expect(await readReconciliation(b.state)).toBeNull()
  expect(await b.fs.read(path)).toEqual(encodeText('newer edit'))
  expect((await owner.manifest()).items.map((item) => item.path)).toEqual([path])
  const local = []
  for await (const file of b.fs.list()) local.push(file.path)
  expect(local).toEqual([path])
})

it('keeps companion-only plugin updates staged across restarts without treating old installed files as a restore', async () => {
  const { a, b } = await fixture()
  const manifest = '.obsidian/plugins/example/manifest.json'
  const styles = '.obsidian/plugins/example/styles.css'
  for (const path of [main, manifest, styles])
    await a.fs.writeAtomic(path, encodeText('before'), 100)
  await a.restart().sync()
  const first = b.restart()
  await first.sync()
  await first.applyDeferred()
  for (const path of [manifest, styles]) await a.fs.writeAtomic(path, encodeText('after'), 200)
  await a.restart().sync()
  for (let pass = 0; pass < 2; pass++) {
    const restarted = b.restart()
    await restarted.sync()
    expect(await readReconciliation(b.state)).toBeNull()
    expect((await restarted.deferred()).map((change) => change.path).sort()).toEqual(
      [manifest, styles].sort()
    )
    for (const path of [main, manifest, styles])
      expect(await b.fs.read(path)).toEqual(encodeText('before'))
  }
})
