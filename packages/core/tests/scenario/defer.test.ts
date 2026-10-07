import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EngineError, MemoryFileSystem, readStaged } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, nextMtime } from '../helpers/device.js'
import { create, seed, shaOf } from '../helpers/seed.js'
import { APP, CONFIG, PLUGIN, head, pairOf, type Pair } from '../helpers/deferPair.js'

/**
 * Staged settings: a device that stages its config folder takes the
 * server's changes there into a record instead of onto the disk, and writes them — or sends its
 * own over them — when the host says. The companion raw engine has no defer callback.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

const pair = (label: string, extra: Record<string, string> = {}): Promise<Pair> =>
  pairOf(h, account, label, extra)

describe('a device that stages its settings', () => {
  it('stages a pulled settings change: the disk, the entry and the push are untouched', async () => {
    const { a, b } = await pair('defer-stage')
    const entry = await a.state.get(APP)
    const commits = a.stats.commits

    await b.write(APP, '{"a":2}')
    await b.write('Note.md', 'a note, edited\n')
    await b.sync()
    const report = await a.sync()

    expect(await a.text(APP)).toBe('{"a":1}')
    expect(await a.state.get(APP)).toEqual(entry)
    // The note beside it is written as ever.
    expect(await a.text('Note.md')).toBe('a note, edited\n')
    expect(await a.cursor()).toBe(report.pull.cursor)
    expect(report.pull.cursor).toBe(a.engine.status.headSeq)
    expect(report.pull.deferred).toBe(1)
    expect(report.deferred).toBe(1)
    expect(a.engine.status.deferred).toBe(1)
    expect((await a.engine.deferred()).map((c) => [c.op, c.path, c.actor.name])).toEqual([
      ['modify', APP, 'B'],
    ])
    expect(a.stats.commits).toBe(commits)
    // The next sync neither pushes it nor stages it again.
    const again = await a.sync()
    expect(again.push.committed).toBeNull()
    expect(again.pull.deferred).toBe(0)
    expect(again.deferred).toBe(1)
  })

  it('replaces a staged change with the next one to the same file', async () => {
    const { a, b } = await pair('defer-replace')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    await b.write(APP, '{"a":3}')
    await b.sync()
    await a.sync()

    const staged = await a.engine.deferred()
    expect(staged).toHaveLength(1)
    expect(staged[0]?.sha).toBe(await shaOf('{"a":3}'))
    expect(a.engine.status.deferred).toBe(1)
  })

  it('writes the staged changes on applyDeferred, and then has nothing to send', async () => {
    const { a, b } = await pair('defer-apply')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()

    const result = await a.engine.applyDeferred()
    expect(result).toEqual({ applied: [APP], skipped: [] })
    expect(await a.text(APP)).toBe('{"a":2}')
    expect((await a.state.get(APP))?.sha).toBe(await shaOf('{"a":2}'))
    expect(a.engine.status.deferred).toBe(0)
    expect(await a.engine.deferred()).toEqual([])
    const after = await a.sync()
    expect(after.push.committed).toBeNull()
    await a.assertStateMatchesDisk()
  })

  it('skips a file edited here since it was staged, pushes the edit, and drops the record', async () => {
    const { a, b } = await pair('defer-local-edit')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    await a.write(APP, '{"a":"here"}')

    const result = await a.engine.applyDeferred()
    expect(result).toEqual({ applied: [], skipped: [APP] })
    expect(await a.text(APP)).toBe('{"a":"here"}')
    expect(a.engine.status.deferred).toBe(1)

    const report = await a.sync()
    expect(report.push.committed).not.toBeNull()
    expect(report.deferred).toBe(0)
    expect(await a.engine.deferred()).toEqual([])
    expect(a.lines.join('\n')).toContain(
      `your change to ${APP} on this device replaced the one from B`
    )
    expect(await a.text(APP)).toBe('{"a":"here"}')
    await b.sync()
    expect(await b.text(APP)).toBe('{"a":"here"}')
  })

  it('stages a change and pushes a newer edit made here in the same sync, which wins', async () => {
    const { a, b, seeder } = await pair('defer-same-run')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.write(APP, '{"a":"here, later"}')
    const report = await a.sync()

    expect(report.pull.deferred).toBe(1)
    expect(report.pull.held).toEqual([])
    expect(report.deferred).toBe(0)
    expect(await a.text(APP)).toBe('{"a":"here, later"}')
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"here, later"}'))
    expect(a.lines.join('\n')).toContain(
      `your change to ${APP} on this device replaced the one from B`
    )
  })

  it('keeps an edit made here that lost to a newer one on the disk, and the newer one staged', async () => {
    const { a, b, seeder } = await pair('defer-older-edit')
    await a.write(APP, '{"a":"here, earlier"}')
    await b.write(APP, '{"a":"there, later"}')
    await b.sync()
    const report = await a.sync()

    // The server keeps the newer; its answer to this edit is staged, not written under Obsidian.
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"there, later"}'))
    expect(await a.text(APP)).toBe('{"a":"here, earlier"}')
    expect(report.deferred).toBe(1)
    const staged = await a.engine.deferred()
    expect(staged.map((one) => [one.path, one.actor.name])).toEqual([[APP, 'B']])
    expect(staged[0]?.sha).toBe(await shaOf('{"a":"there, later"}'))
    expect(a.lines.join('\n')).toContain(`push: the vault keeps B's ${APP}; staged, not written`)
    // Nothing more goes out for it until the person decides.
    expect((await a.sync()).push.committed).toBeNull()

    await a.engine.applyDeferred()
    expect(await a.text(APP)).toBe('{"a":"there, later"}')
    expect((await a.sync()).push.committed).toBeNull()
    await a.assertStateMatchesDisk()
  })

  it("keepLocal sends this device's bytes as a change on the head", async () => {
    const { a, b, seeder } = await pair('defer-keep')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    const theirs = await head(seeder, APP)

    expect(await a.engine.keepLocal()).toEqual({ kept: [APP], left: [] })
    expect(a.engine.status.deferred).toBe(0)
    const report = await a.sync()
    expect(report.push.applied).toBe(1)
    expect(report.push.merged).toBe(0)
    const now = await head(seeder, APP)
    expect(now?.sha).toBe(await shaOf('{"a":1}'))
    expect(now?.version_id).not.toBe(theirs?.version_id)
    // B's bytes are a version before it: nothing is lost.
    const versions = await seeder.versions(now!.file_id)
    expect(versions.map((v) => v.sha)).toContain(await shaOf('{"a":2}'))
    await b.sync()
    expect(await b.text(APP)).toBe('{"a":1}')
    await a.assertStateMatchesDisk()
  })

  it('stages deletes and moves of plugin files, and applies them', async () => {
    const { a, b, seeder } = await pair('defer-plugin-files')
    await b.rm(`${PLUGIN}/main.js`)
    await b.mv(`${PLUGIN}/styles.css`, '.obsidian/snippets/p.css')
    await b.sync()
    const report = await a.sync()

    expect(report.pull.deferred).toBe(2)
    expect(a.has(`${PLUGIN}/main.js`)).toBe(true)
    expect(a.has(`${PLUGIN}/styles.css`)).toBe(true)
    expect((await a.engine.deferred()).map((c) => c.op).sort()).toEqual(['delete', 'move'])

    const result = await a.engine.applyDeferred()
    expect(result.applied.sort()).toEqual([`${PLUGIN}/main.js`, '.obsidian/snippets/p.css'].sort())
    expect(a.has(`${PLUGIN}/main.js`)).toBe(false)
    expect(a.has(`${PLUGIN}/styles.css`)).toBe(false)
    expect(await a.text('.obsidian/snippets/p.css')).toBe('p {}')
    expect(await a.state.get(`${PLUGIN}/main.js`)).toBeNull()
    const after = await a.sync()
    expect(after.push.committed).toBeNull()
    expect((await seeder.trash()).map((t) => t.path)).toEqual([`${PLUGIN}/main.js`])
    await a.assertStateMatchesDisk()
  })

  it('keeps its own copy of a file the server deleted, and sends it back', async () => {
    const { a, b, seeder } = await pair('defer-keep-deleted')
    await b.rm(`${PLUGIN}/main.js`)
    await b.sync()
    await a.sync()

    expect(await a.engine.keepLocal([`${PLUGIN}/main.js`])).toEqual({
      kept: [`${PLUGIN}/main.js`],
      left: [],
    })
    await a.sync()
    expect((await head(seeder, `${PLUGIN}/main.js`))?.sha).toBe(await shaOf('main()'))
    await b.sync()
    expect(await b.text(`${PLUGIN}/main.js`)).toBe('main()')
  })

  it('keeps only what this disk has: files only the other device has are left there', async () => {
    const snippets: Record<string, string> = {}
    for (let k = 0; k < 60; k++) snippets[`.obsidian/snippets/s${k}.css`] = `s${k} {}`
    const { a, b, seeder } = await pair('defer-keep-absent')
    // B adds sixty snippets; A stages them, and then keeps its own, which has none of them.
    for (const [path, text] of Object.entries(snippets)) await b.write(path, text)
    await b.sync()
    await a.sync()
    expect(a.engine.status.deferred).toBe(60)
    const commits = a.stats.commits

    const result = await a.engine.keepLocal()
    expect(result.kept).toEqual([])
    expect(result.left.sort()).toEqual(Object.keys(snippets).sort())
    expect(a.engine.status.deferred).toBe(0)
    const report = await a.sync()
    expect(report.push.committed).toBeNull()
    expect(a.stats.commits).toBe(commits)
    expect(a.engine.status.heldDeletes).toBe(0)
    expect(await seeder.trash()).toEqual([])
    const live = (await seeder.manifest(null)).items.map((i) => i.path)
    expect(live.filter((p) => p.startsWith('.obsidian/snippets/'))).toHaveLength(60)
    expect(a.paths().filter((p) => p.startsWith('.obsidian/snippets/'))).toEqual([])
    await b.sync()
    expect(b.paths().filter((p) => p.startsWith('.obsidian/snippets/'))).toHaveLength(60)
  })

  it('leaves a plugin installed on the other device there, and says it left it', async () => {
    const { a, b, seeder } = await pair('defer-keep-plugin')
    const main = '.obsidian/plugins/x/main.js'
    await b.write(main, 'x()')
    await b.sync()
    await a.sync()

    expect(await a.engine.keepLocal()).toEqual({ kept: [], left: [main] })
    await a.sync()
    expect((await head(seeder, main))?.sha).toBe(await shaOf('x()'))
    expect(a.has(main)).toBe(false)
    await b.sync()
    expect(await b.text(main)).toBe('x()')
  })

  it('reads a kept-deletes list an older build filed as nothing: those deletes meet the guard', async () => {
    const snippets: Record<string, string> = {}
    for (let k = 0; k < 60; k++) snippets[`.obsidian/snippets/s${k}.css`] = `s${k} {}`
    const { vaultId, a, seeder } = await pair('defer-old-kept', snippets)
    const ids: string[] = []
    for (const path of Object.keys(snippets)) {
      ids.push((await a.state.get(path))!.fileId)
      await a.rm(path)
    }
    await a.state.setMeta!('deferred-changes', JSON.stringify({ staged: [], keptDeletes: ids }))
    const again = new Device(h, vaultId, a.deviceToken, 'A', {
      fs: a.fs,
      state: a.state,
      defer: CONFIG,
    })
    await again.sync()
    expect(again.engine.status.heldDeletes).toBe(60)
    expect(await seeder.trash()).toEqual([])
  })

  it('stages a whole config folder on a first sync, and adopts the files already here', async () => {
    const { vaultId, seeder } = await pair('defer-join')
    const fs = new MemoryFileSystem()
    await fs.writeAtomic(APP, new TextEncoder().encode('{"a":1}'), nextMtime())
    const c = new Device(h, vaultId, (await h.device(account, vaultId, 'C')).deviceToken, 'C', {
      fs,
      defer: CONFIG,
    })
    const report = await c.sync()
    expect(report.deferred).toBe(3)
    expect(c.has('Note.md')).toBe(true)
    expect(c.has(`${PLUGIN}/main.js`)).toBe(false)
    // The same bytes were here already: nothing to write, so nothing to stage.
    expect((await c.state.get(APP))?.fileId).toBe((await head(seeder, APP))?.file_id)
    expect(report.push.committed).toBeNull()

    await c.engine.applyDeferred()
    expect(await c.text(`${PLUGIN}/main.js`)).toBe('main()')
    await c.assertStateMatchesDisk()
  })

  it('keeps what it staged across a restart, in the state', async () => {
    const { vaultId, a, b } = await pair('defer-restart')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    expect(await readStaged(a.state)).toHaveLength(1)

    const again = new Device(h, vaultId, a.deviceToken, 'A', {
      fs: a.fs,
      state: a.state,
      defer: CONFIG,
    })
    expect(await again.engine.deferred()).toHaveLength(1)
    // The status says so before any sync has run.
    await vi.waitFor(() => expect(again.engine.status.deferred).toBe(1))
    const report = await again.sync()
    expect(report.deferred).toBe(1)
    expect(report.pull.deferred).toBe(0)
    await again.engine.applyDeferred()
    expect(await again.text(APP)).toBe('{"a":2}')
  })

  it('writes what it staged once the host stages nothing, as the daemon does', async () => {
    const { vaultId, a, b } = await pair('defer-release')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()

    const daemon = new Device(h, vaultId, a.deviceToken, 'A', { fs: a.fs, state: a.state })
    const report = await daemon.sync()
    expect(await daemon.text(APP)).toBe('{"a":2}')
    expect(report.deferred).toBe(0)
    expect(await readStaged(a.state)).toEqual([])
    await daemon.assertStateMatchesDisk()
  })

  it('stages nothing without a defer, as today', async () => {
    const { a, b } = await pair('defer-none')
    await a.write(APP, '{"a":"from A"}')
    await a.sync()
    const report = await b.sync()
    expect(await b.text(APP)).toBe('{"a":"from A"}')
    expect(report.deferred).toBe(0)
    expect(report.pull.deferred).toBe(0)
    expect(b.engine.status.deferred).toBe(0)
  })
})

describe('staged changes and the other guards', () => {
  it('a staged delete of many plugin files is not a mass delete, applied or done here too', async () => {
    const snippets: Record<string, string> = {}
    for (let k = 0; k < 60; k++) snippets[`.obsidian/snippets/s${k}.css`] = `s${k} {}`
    const { vaultId, a, b, seeder } = await pair('defer-guard', snippets)
    for (const path of Object.keys(snippets)) await b.rm(path)
    await b.sync()
    // B's own guard holds them; B means it.
    await b.engine.decideDeletes(
      'confirm',
      (await b.engine.heldDeletes()).map((one) => one.fileId)
    )
    expect(await seeder.trash()).toHaveLength(60)
    await a.sync()
    expect(a.engine.status.deferred).toBe(60)
    expect(a.engine.status.heldDeletes).toBe(0)

    // Applied: gone here, and nothing more to send or hold.
    await a.engine.applyDeferred()
    const after = await a.sync()
    expect(after.push.committed).toBeNull()
    expect(a.engine.status.heldDeletes).toBe(0)
    expect(Object.keys(snippets).some((p) => a.has(p))).toBe(false)

    // Deleted here as well before anything was applied: settled, not sent, not held.
    const c = new Device(h, vaultId, (await h.device(account, vaultId, 'C')).deviceToken, 'C', {
      defer: CONFIG,
    })
    await seed(seeder, [await create(seeder, 'Other.md', 'x\n')])
    await c.sync()
    await c.engine.applyDeferred()
    await b.write('.obsidian/snippets/t.css', 't {}')
    for (let k = 0; k < 59; k++) await b.write(`.obsidian/snippets/u${k}.css`, `u${k} {}`)
    await b.sync()
    await c.sync()
    await c.engine.applyDeferred()
    for (let k = 0; k < 59; k++) await b.rm(`.obsidian/snippets/u${k}.css`)
    await b.sync()
    await b.engine.decideDeletes(
      'confirm',
      (await b.engine.heldDeletes()).map((one) => one.fileId)
    )
    await c.sync()
    expect(c.engine.status.deferred).toBe(59)
    for (let k = 0; k < 59; k++) await c.rm(`.obsidian/snippets/u${k}.css`)
    const report = await c.sync()
    expect(c.engine.status.heldDeletes).toBe(0)
    expect(c.engine.status.deferred).toBe(0)
    expect(report.push.committed).toBeNull()
    expect(c.lines.join('\n')).toMatch(/59 files deleted here were deleted on the server too/)
  })

  it('drops a staged change when its file leaves the scope, and stages it again when it comes back', async () => {
    const { a, b } = await pair('defer-scope', { '.obsidian/snippets/s.css': 's {}' })
    await b.write('.obsidian/snippets/s.css', 's { color: red }')
    await b.sync()
    await a.sync()
    expect(a.engine.status.deferred).toBe(1)

    a.selective.settings.appearance = false
    await a.sync()
    expect(a.engine.status.deferred).toBe(0)
    expect(await a.text('.obsidian/snippets/s.css')).toBe('s {}')

    a.selective.settings.appearance = true
    const back = await a.sync()
    expect(back.pull.bootstrapped).toBe(true)
    expect(a.engine.status.deferred).toBe(1)
    await a.engine.applyDeferred()
    expect(await a.text('.obsidian/snippets/s.css')).toBe('s { color: red }')
  })

  it('stages, rather than deletes, a settings file the server lost while out of scope', async () => {
    const { a, b } = await pair('defer-scope-gone', { '.obsidian/snippets/s.css': 's {}' })
    a.selective.settings.appearance = false
    await a.sync()
    await b.rm('.obsidian/snippets/s.css')
    await b.sync()
    a.selective.settings.appearance = true
    await a.sync()
    expect(a.has('.obsidian/snippets/s.css')).toBe(true)
    expect((await a.engine.deferred()).map((c) => [c.op, c.path])).toEqual([
      ['delete', '.obsidian/snippets/s.css'],
    ])
    await a.engine.applyDeferred()
    expect(a.has('.obsidian/snippets/s.css')).toBe(false)
    expect(await a.state.get('.obsidian/snippets/s.css')).toBeNull()
  })

  it('files nothing once the claim on the vault has lapsed', async () => {
    const { vaultId, a, b } = await pair('defer-held')
    await b.write(APP, '{"a":2}')
    await b.sync()
    let held = true
    const guarded = new Device(h, vaultId, a.deviceToken, 'A', {
      fs: a.fs,
      state: a.state,
      defer: CONFIG,
      stillHeld: () => held,
    })
    await guarded.sync()
    expect(await readStaged(a.state)).toHaveLength(1)
    held = false
    const lost = await guarded.engine.applyDeferred().catch((e: unknown) => e)
    expect(lost).toBeInstanceOf(EngineError)
    expect((lost as EngineError).code).toBe('lost')
    expect(await a.text(APP)).toBe('{"a":1}')
    expect(await readStaged(a.state)).toHaveLength(1)
  })
})
