import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { encodeText, selectiveDefaults } from '@abele/sync-core'

// Kill the process model after a completed filesystem await. All later I/O (including
// catch/finally cleanup) fails until restart, so a thrown exception cannot undo the cut.
const crash = vi.hoisted(() => ({
  armed: false,
  dead: false,
  cut: 0,
  points: [] as string[],
  exact: '',
  handles: new Set<{ close(): Promise<void> }>(),
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const boundary = async (label: string, call: () => Promise<unknown>) => {
    if (crash.dead) throw new Error('process crashed')
    let value: unknown, error: unknown
    try {
      value = await call()
    } catch (caught) {
      error = caught
    }
    if (crash.armed) {
      crash.points.push(label)
      if (crash.points.length === crash.cut || (crash.exact && label === crash.exact))
        crash.dead = true
    }
    if (crash.dead) throw new Error('process crashed')
    if (error) throw error
    return value
  }
  return Object.fromEntries(
    Object.entries(actual).map(([name, fn]) => [
      name,
      typeof fn !== 'function'
        ? fn
        : async (...args: unknown[]) => {
            const value = await boundary(
              `${name}:${String(args[0])}${name === 'rename' || name === 'link' ? `->${String(args[1])}` : ''}`,
              async () => {
                const result = await Reflect.apply(fn, actual, args)
                if (name === 'open' || name === 'opendir') crash.handles.add(result)
                return result
              }
            )
            if (name !== 'open' && name !== 'opendir') return value
            return new Proxy(value as object, {
              get(target, key) {
                const method = Reflect.get(target, key, target)
                if (key === Symbol.asyncIterator)
                  return async function* () {
                    const iterator = method.call(target)
                    try {
                      for (;;) {
                        const next = (await boundary(`directory.next:${String(args[0])}`, () =>
                          iterator.next()
                        )) as IteratorResult<unknown>
                        if (next.done) {
                          crash.handles.delete(target as { close(): Promise<void> })
                          return
                        }
                        yield next.value
                      }
                    } finally {
                      if (!crash.dead) {
                        await iterator.return?.()
                        crash.handles.delete(target as { close(): Promise<void> })
                      }
                    }
                  }
                return typeof method !== 'function'
                  ? method
                  : (...params: unknown[]) =>
                      boundary(`handle.${String(key)}:${String(args[0])}`, async () => {
                        // This property models process crashes, not power loss. Retain
                        // every fsync await/cut without repeated hardware barriers; the
                        // separate durability tests exercise the real ordered barriers.
                        const result =
                          key === 'sync' ? undefined : await method.apply(target, params)
                        if (key === 'close')
                          crash.handles.delete(target as { close(): Promise<void> })
                        return result
                      })
              },
            })
          },
    ])
  )
})
import { CodeDraft } from '../../src/codeDraft.js'
import { CodeGroupDisk } from '../../src/codeGroupDisk.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { recoverNodeReplica, type NodeReplica } from '../../src/replica.js'

// Equivalent durable images share a recovery trace. Replay each distinct image once,
// while still cutting and checking every lifecycle await for all three operations.
const recoveryImages = new Set<string>()
const normal = (text: string) =>
  text
    .replace(/group-[a-zA-Z0-9]+/g, 'group-ID')
    .replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g, 'UUID')
    .replace(/[a-f0-9]{24,64}/g, 'HEX')

async function recoverySnapshot(dir: string, state: SqliteStateStore, mode: string) {
  const raw = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const backup = await raw.mkdtemp(join(tmpdir(), 'group-image-'))
  const entries: Array<{ path: string; directory: boolean; inode: string; data?: string }> = []
  async function collect(folder = ''): Promise<void> {
    for (const entry of await raw.readdir(join(dir, folder), { withFileTypes: true })) {
      const path = folder ? `${folder}/${entry.name}` : entry.name
      const info = await raw.lstat(join(dir, path))
      if (entry.isDirectory()) {
        entries.push({ path, directory: true, inode: '' })
        await raw.mkdir(join(backup, path), { recursive: true })
        await collect(path)
      } else {
        if (!entry.isFile()) throw new Error('unexpected non-file in crash image')
        const bytes = await raw.readFile(join(dir, path))
        let data = bytes.toString('hex')
        if (path.endsWith('.json')) {
          const parsed = JSON.parse(bytes.toString())
          if (parsed.sentinel) {
            const victim = await raw.lstat(join(dir, dirname(path), 'victim')).catch(() => null)
            parsed.sentinel = {
              stillAllocated:
                victim?.ino === parsed.sentinel.ino && victim?.dev === parsed.sentinel.dev,
            }
          }
          data = JSON.stringify(parsed)
        }
        entries.push({
          path,
          directory: false,
          inode: `${info.dev}:${info.ino}`,
          data: path.includes('state.db') ? 'ledger' : data,
        })
        // Preserve inode identities and alias topology, including capture sentinels.
        // SQLite is copied separately after close because it writes in place.
        if (!path.includes('state.db')) await raw.link(join(dir, path), join(backup, path))
      }
    }
  }
  await collect()
  const aliases = new Map<string, string[]>()
  for (const entry of entries)
    if (!entry.directory)
      aliases.set(entry.inode, [...(aliases.get(entry.inode) ?? []), normal(entry.path)])
  const metadata = state.metadataKeys('').map((key) => [key, state.getMeta(key)])
  const signature = normal(
    JSON.stringify([
      mode,
      metadata,
      entries.map((entry) => ({
        path: entry.path,
        data: entry.data,
        aliases: aliases.get(entry.inode),
      })),
    ])
  )
  return { backup, raw, signature, entries }
}

async function run(
  cut = 0,
  exact: 'capture' | 'publication' | 'first-save' | '' = '',
  mode: 'write' | 'remove' | 'move' = 'write',
  recoveryCut: number | 'restoring' = 0,
  nested = false
) {
  const dir = await mkdtemp(join(tmpdir(), 'group-cut-'))
  const disk = new NodeFileSystem(dir)
  let state = SqliteStateStore.open(join(dir, '.abele-sync/state.db'))
  const cfg = {
    serverUrl: 'https://sync.example.test',
    vaultId: 'vault',
    deviceId: 'device',
    deviceToken: 'absd_test',
    deviceName: 'Test',
    selective: selectiveDefaults(),
  }
  const vault = { dir, disk, state, cfg }
  try {
    await disk.writeAtomic('file.bin', encodeText('original'), 1)
    // Resolve the random allocation names at runtime for exact syscall cuts.
    crash.points = []
    crash.cut = cut
    crash.exact = ''
    crash.armed = true
    // The label contains the random quarantine id, so identify the selected syscall
    // by the fixed public endpoint rather than a fabricated recovery fixture.
    const select = exact
    const points = crash.points
    if (select) {
      points.push = (...labels: string[]) => {
        const length = Array.prototype.push.apply(points, labels)
        if (
          labels.some((label) =>
            select === 'capture'
              ? label.startsWith(`rename:${join(dir, 'file.bin')}->`) && label.endsWith('/victim')
              : select === 'first-save'
                ? label.startsWith('writeFile:') &&
                  label.includes('/code-approvals/') &&
                  /\/tmp\/[a-f0-9]{24}$/.test(label)
                : label.startsWith('link:') &&
                  label.endsWith(`->${join(dir, mode === 'move' ? 'moved.bin' : 'file.bin')}`)
          )
        )
          crash.cut = length
        return length
      }
    }
    let failed = false
    try {
      const group = await CodeGroupDisk.create(vault, () => true)
      const draft = await CodeDraft.create(disk, group.work)
      if (mode === 'write') await draft.writeAtomic('file.bin', encodeText('approved'), 2)
      else if (mode === 'remove') await draft.remove('file.bin')
      else await draft.move('file.bin', 'moved.bin')
      await state.transaction(() => group.place(draft))
    } catch (error) {
      if (!crash.dead) throw error
      failed = true
    }
    const count = crash.points.length
    crash.armed = false
    crash.dead = false
    // A real process exit closes descriptors even though its finally blocks never run.
    for (const handle of crash.handles)
      await handle.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error
      })
    crash.handles.clear()
    expect(failed).toBe(cut > 0 || !!exact)
    if (exact === 'capture') expect(await disk.stat('file.bin')).toBeNull()
    if (recoveryCut) {
      crash.points = []
      crash.cut = typeof recoveryCut === 'number' ? recoveryCut : 0
      if (recoveryCut === 'restoring') {
        const points = crash.points
        points.push = (...labels: string[]) => {
          const length = Array.prototype.push.apply(points, labels)
          if (
            labels.some((label) => label.startsWith('writeFile:') && label.endsWith('/restoring'))
          )
            crash.cut = length
          return length
        }
      }
      crash.armed = true
      try {
        await recoverNodeReplica({ ...vault } as NodeReplica, () => true)
      } catch (error) {
        if (!crash.dead) throw error
      }
      expect(crash.dead).toBe(true)
      crash.armed = false
      crash.dead = false
      for (const handle of crash.handles)
        await handle.close().catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ERR_DIR_CLOSED') throw error
        })
      crash.handles.clear()
    }
    const checkImage = async () => {
      const read = async (path: string) =>
        (await disk.stat(path)) ? new TextDecoder().decode(await disk.read(path)) : null
      const image = [await read('file.bin'), await read('moved.bin')]
      const before = ['original', null],
        after =
          mode === 'write'
            ? ['approved', null]
            : mode === 'remove'
              ? [null, null]
              : [null, 'original']
      expect(image).toEqual(failed ? before : after)
    }
    const check = async () => {
      await checkImage()
      const expectedNames = ['.abele-sync']
      for (const path of ['file.bin', 'moved.bin'])
        if (await disk.stat(path)) expectedNames.push(path)
      expect((await readdir(dir)).sort()).toEqual(expectedNames.sort())
      for (const folder of [
        'conditional',
        'conditional-complete',
        'installations',
        'code-approvals',
      ]) {
        const names = await readdir(join(dir, '.abele-sync', folder)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return []
            throw error
          }
        )
        expect(names, `leaked ${folder} at ${cut}/${exact}`).toEqual([])
      }
    }
    if (nested && failed) {
      const snapshot = await recoverySnapshot(dir, state, mode)
      try {
        if (!recoveryImages.has(snapshot.signature)) {
          recoveryImages.add(snapshot.signature)
          state.close()
          // A closed SQLite image includes the rolled-back transaction, not a live WAL.
          await snapshot.raw.copyFile(
            join(dir, '.abele-sync/state.db'),
            join(snapshot.backup, '.abele-sync/state.db')
          )
          const restore = async () => {
            state.close()
            for (const entry of await snapshot.raw.readdir(dir))
              await snapshot.raw.rm(join(dir, entry), { recursive: true, force: true })
            for (const entry of snapshot.entries) {
              if (entry.path.includes('state.db')) continue
              if (entry.directory)
                await snapshot.raw.mkdir(join(dir, entry.path), { recursive: true })
              else await snapshot.raw.link(join(snapshot.backup, entry.path), join(dir, entry.path))
            }
            await snapshot.raw.copyFile(
              join(snapshot.backup, '.abele-sync/state.db'),
              join(dir, '.abele-sync/state.db')
            )
            state = SqliteStateStore.open(join(dir, '.abele-sync/state.db'))
            vault.state = state
          }
          await restore()
          crash.points = []
          crash.cut = 0
          crash.armed = true
          await recoverNodeReplica({ ...vault } as NodeReplica, () => true)
          const recoveryCount = crash.points.length
          crash.armed = false
          for (let second = 1; second <= recoveryCount; second++) {
            await restore()
            crash.points = []
            crash.cut = second
            crash.armed = true
            try {
              await recoverNodeReplica({ ...vault } as NodeReplica, () => true)
            } catch (error) {
              if (!crash.dead) throw error
            }
            expect(crash.dead, `unreached recovery cut ${second}`).toBe(true)
            crash.armed = false
            crash.dead = false
            for (const handle of crash.handles)
              await handle.close().catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ERR_DIR_CLOSED') throw error
              })
            crash.handles.clear()
            try {
              await recoverNodeReplica({ ...vault } as NodeReplica, () => true)
              await check()
            } catch (error) {
              throw new Error(`${mode} lifecycle ${cut}, recovery ${second}/${recoveryCount}`, {
                cause: error,
              })
            }
          }
        }
      } finally {
        await snapshot.raw.rm(snapshot.backup, { recursive: true, force: true })
      }
    }
    // Restart composition, not an artificially reordered sequence of helpers.
    await recoverNodeReplica({ ...vault } as NodeReplica, () => true)
    await check()
    await recoverNodeReplica(vault as NodeReplica, () => true)
    await check()
    return count
  } finally {
    crash.armed = false
    crash.dead = false
    for (const handle of crash.handles)
      await handle.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error
      })
    crash.handles.clear()
    state.close()
    await rm(dir, { recursive: true, force: true })
  }
}

it('D-068 restarts after group source capture before publication', async () => {
  await run(0, 'capture')
})

it('D-070 retires a receiptless write interrupted immediately after publication', async () => {
  await run(0, 'publication')
})

it('D-074 recovers a crash during the very first journal save', async () => {
  await run(0, 'first-save')
})
it('D-075 recovers a second crash after the restoration marker before restoring the victim', async () => {
  await run(0, 'capture', 'write', 'restoring')
})
it('D-076 recognises a move published immediately before a crash', async () => {
  await run(0, 'publication', 'move')
})

for (const mode of ['write', 'remove', 'move'] as const)
  it(`group ${mode} converges after every lifecycle await and every nested recovery await`, async () => {
    const count = await run(0, '', mode)
    expect(count).toBeGreaterThan(0)
    for (let cut = 1; cut <= count; cut++) {
      try {
        await run(cut, '', mode, 0, true)
      } catch (error) {
        throw new Error(`group restart failed at await ${cut}/${count}`, { cause: error })
      }
    }
    console.info(
      `Group ${mode} recovery replayed ${count} lifecycle awaits; ${recoveryImages.size} distinct recovery images`
    )
  }, 600_000)
