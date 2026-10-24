import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeText, selectiveDefaults } from '@abele/sync-core'

// Kill the process model after a completed filesystem await. All later I/O (including
// catch/finally cleanup) fails until restart, so a thrown exception cannot undo the cut.
const { state: crash, run: inCrashScope } = await vi.hoisted(async () => {
  const { crashScope } = await import('../helpers/crashScope.js')
  return crashScope(() => ({
    armed: false,
    dead: false,
    cut: 0,
    phaseSteps: 0,
    points: [] as string[],
    exact: '',
    handles: new Set<{ close(): Promise<void> }>(),
    fold: false,
    root: '',
    signal: undefined as AbortSignal | undefined,
  }))
})
// Like FileHandle.sync below, SQLite's physical flush is not a process-crash
// boundary. Keep the real driver/transactions/WAL, without thousands of native
// fsyncs that cannot be intercepted by the filesystem promise mock.
vi.mock('better-sqlite3', async (original) => {
  const sqlite = await original<{ default: typeof import('better-sqlite3') }>()
  return {
    ...sqlite,
    default: new Proxy(sqlite.default, {
      construct(Database, args) {
        const db = Reflect.construct(Database, args) as InstanceType<typeof Database>
        db.pragma('synchronous = OFF')
        return db
      },
    }),
  }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  const resolveCase = async (value: unknown) => {
    if (!crash.fold || typeof value !== 'string' || !value.startsWith(crash.root + '/'))
      return value
    let folder = crash.root
    for (const part of value.slice(crash.root.length + 1).split('/')) {
      const names = await actual.readdir(folder).catch(() => [] as string[])
      folder = join(
        folder,
        names.find((name) => name === part) ??
          names.find((name) => name.toLowerCase() === part.toLowerCase()) ??
          part
      )
    }
    return folder
  }
  const boundary = async (label: string, call: () => Promise<unknown>) => {
    crash.signal?.throwIfAborted()
    if (++crash.phaseSteps > 1024)
      throw new Error(`replay phase exceeded 1024 filesystem awaits at ${label}`)
    if (crash.dead) throw new Error('process crashed')
    let value: unknown, error: unknown
    try {
      value = await call()
    } catch (caught) {
      error = caught
    }
    crash.signal?.throwIfAborted()
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
                if (
                  name === 'rm' &&
                  (args[1] as { recursive?: boolean })?.recursive &&
                  String(args[0]).includes('/code-approvals/')
                ) {
                  const removeEntry = async (path: string): Promise<void> => {
                    const info = await actual.lstat(path).catch((error: NodeJS.ErrnoException) => {
                      if (error.code === 'ENOENT') return null
                      throw error
                    })
                    if (!info) return
                    if (info.isDirectory()) {
                      // Exercise the destructive ordering identified in D-079.
                      const children = (await actual.readdir(path)).sort(
                        (a, b) => Number(b === 'journal.json') - Number(a === 'journal.json')
                      )
                      for (const child of children) await removeEntry(join(path, child))
                      await boundary(`rm.entry:${path}`, () => actual.rmdir(path))
                    } else await boundary(`rm.entry:${path}`, () => actual.unlink(path))
                  }
                  await removeEntry(String(args[0]))
                  return
                }
                const resolved = [...args]
                resolved[0] = await resolveCase(args[0])
                if (['rename', 'link', 'copyFile'].includes(name))
                  resolved[1] = await resolveCase(args[1])
                const result = await Reflect.apply(fn, actual, resolved)
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

it('the process-crash model does not benchmark SQLite power-loss flushes', async () => {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  try {
    expect(db.pragma('synchronous', { simple: true })).toBe(0)
  } finally {
    db.close()
  }
})

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
        data: entry.data?.replace(
          /"moveIdentity":"(\d+:\d+)"/g,
          (_match, id: string) => `"moveIdentity":${JSON.stringify(aliases.get(id) ?? 'retired')}`
        ),
        aliases: aliases.get(entry.inode),
      })),
    ])
  )
  return { backup, raw, signature, entries }
}

function run(...args: Parameters<typeof replay>) {
  return inCrashScope(() => replay(...args))
}

async function replay(
  cut = 0,
  exact: 'capture' | 'publication' | 'first-save' | 'settled-move' | '' = '',
  mode: 'write' | 'remove' | 'move' = 'write',
  recoveryCut: number | 'restoring' | 'discard' | 'review' = 0,
  nested = false,
  editMove: boolean | 'replacement' = false,
  caseOnly = false,
  fold = false,
  invalidJournal = false,
  signal?: AbortSignal
) {
  signal?.throwIfAborted()
  crash.signal = signal
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
  const recover = async (held: () => boolean = () => true) => {
    crash.phaseSteps = 0
    await recoverNodeReplica({ ...vault } as NodeReplica, held)
  }
  crash.fold = fold
  crash.root = dir
  const destination = caseOnly ? (mode === 'move' ? 'File.bin' : 'FILE.BIN') : 'moved.bin'
  const operand = caseOnly && mode !== 'move' ? destination : 'file.bin'
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
              : select === 'settled-move'
                ? label.startsWith('rm:') && label.includes('/conditional/')
                : select === 'first-save'
                  ? label.startsWith('writeFile:') &&
                    label.includes('/code-approvals/') &&
                    /\/tmp\/[a-f0-9]{24}$/.test(label)
                  : label.startsWith('link:') &&
                    label.endsWith(`->${join(dir, mode === 'move' ? destination : operand)}`)
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
      if (mode === 'write') await draft.writeAtomic(operand, encodeText('approved'), 2)
      else if (mode === 'remove') await draft.remove(operand)
      else await draft.move('file.bin', destination)
      await state.transaction((tx) => group.place(draft, tx))
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
    if (editMove) {
      if (editMove === 'replacement')
        await disk.writeAtomic(destination, encodeText('unrelated'), 3)
      else await writeFile(join(dir, destination), encodeText('local edit'))
      await disk.recoverConditionalFiles()
      if (!caseOnly && editMove !== 'replacement')
        expect(
          await disk.stat('file.bin'),
          'a published move must not recreate its source alias'
        ).toBeNull()
    }
    if (invalidJournal) {
      const folder = join(dir, '.abele-sync/code-approvals')
      const group = (await readdir(folder)).find((name) => name.startsWith('group-'))!
      await new NodeFileSystem(join(folder, group)).writeAtomic(
        'journal.json',
        encodeText('{invalid'),
        0
      )
    }
    if (recoveryCut) {
      crash.points = []
      crash.cut = typeof recoveryCut === 'number' ? recoveryCut : 0
      if (typeof recoveryCut === 'string') {
        const points = crash.points
        points.push = (...labels: string[]) => {
          const length = Array.prototype.push.apply(points, labels)
          if (
            labels.some((label) =>
              recoveryCut === 'restoring'
                ? label.startsWith('writeFile:') && label.endsWith('/restoring')
                : recoveryCut === 'review'
                  ? label.startsWith('rename:') &&
                    label.includes('->') &&
                    label.includes('/review-group-')
                  : label.startsWith('rm.entry:') && label.endsWith('/journal.json')
            )
          )
            crash.cut = length
          return length
        }
      }
      crash.armed = true
      try {
        await recover(() => true)
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
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const names = await actual.readdir(dir)
      const read = async (path: string) =>
        names.includes(path)
          ? new TextDecoder().decode(await actual.readFile(join(dir, path)))
          : null
      const image = [await read('file.bin'), await read(destination)]
      const before = ['original', null],
        after =
          mode === 'write'
            ? caseOnly
              ? [null, 'approved']
              : ['approved', null]
            : mode === 'remove'
              ? [null, null]
              : [null, 'original']
      expect(image).toEqual(
        editMove === 'replacement'
          ? caseOnly
            ? [null, 'unrelated']
            : ['original', 'unrelated']
          : editMove
            ? [null, 'local edit']
            : failed
              ? before
              : after
      )
    }
    const check = async () => {
      await checkImage()
      const inodes = new Set<string>()
      const visible = async (folder = ''): Promise<void> => {
        const raw = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
        for (const entry of await raw.readdir(join(dir, folder), { withFileTypes: true })) {
          if (!folder && entry.name === '.abele-sync') continue
          const path = folder ? `${folder}/${entry.name}` : entry.name
          if (entry.isDirectory()) await visible(path)
          else if (entry.isFile()) {
            const info = await raw.lstat(join(dir, path)),
              id = `${info.dev}:${info.ino}`
            expect(inodes.has(id), `visible inode alias at ${path}`).toBe(false)
            inodes.add(id)
          }
        }
      }
      await visible()
      const expectedNames = ['.abele-sync']
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      const actualNames = await actual.readdir(dir)
      for (const path of ['file.bin', destination])
        if (actualNames.includes(path)) expectedNames.push(path)
      if (caseOnly && editMove === 'replacement') {
        const copies = actualNames.filter((name) =>
          name.startsWith('file.bin.sync-conflict-group-')
        )
        expect(copies).toHaveLength(1)
        expect(new TextDecoder().decode(await actual.readFile(join(dir, copies[0]!)))).toBe(
          'original'
        )
        expectedNames.push(...copies)
      }
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
        if (invalidJournal && folder === 'code-approvals') {
          const reviews = CodeGroupDisk.reviews(vault)
          expect(reviews).toHaveLength(1)
          expect(names).toEqual([basename(reviews[0]!.path)])
          const retained = new NodeFileSystem(join(dir, reviews[0]!.path))
          expect(new TextDecoder().decode(await retained.read('journal.json'))).toBe('{invalid')
          expect(await readdir(join(dir, reviews[0]!.path, 'blobs'))).not.toHaveLength(0)
        } else expect(names, `leaked ${folder} at ${cut}/${exact}`).toEqual([])
      }
    }
    if (nested && failed) {
      const snapshot = await recoverySnapshot(dir, state, mode)
      try {
        if (!recoveryImages.has(snapshot.signature)) {
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
          await recover(() => true)
          const recoveryCount = crash.points.length
          crash.armed = false
          for (let second = 1; second <= recoveryCount; second++) {
            signal?.throwIfAborted()
            await restore()
            crash.points = []
            crash.cut = second
            crash.armed = true
            try {
              await recover(() => true)
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
              await recover(() => true)
              await check()
            } catch (error) {
              throw new Error(`${mode} lifecycle ${cut}, recovery ${second}/${recoveryCount}`, {
                cause: error,
              })
            }
          }
          // A cancelled/failed replay must not mark an image as covered.
          recoveryImages.add(snapshot.signature)
        }
      } finally {
        await snapshot.raw.rm(snapshot.backup, { recursive: true, force: true })
      }
    }
    // Restart composition, not an artificially reordered sequence of helpers.
    await recover(() => true)
    await check()
    await recover(() => true)
    await check()
    return count
  } finally {
    crash.phaseSteps = 0
    crash.signal = undefined
    crash.armed = false
    crash.dead = false
    for (const handle of crash.handles)
      await handle.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ERR_DIR_CLOSED') throw error
      })
    crash.handles.clear()
    state.close()
    await rm(dir, { recursive: true, force: true })
    crash.fold = false
    crash.root = ''
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
it('D-079 recovers after recursive discard removes journal.json before the draft', async () => {
  await run(0, '', 'write', 'discard')
})
it('D-080 preserves a published move edited in place before recovery with one visible inode name', async () => {
  await run(0, 'publication', 'move', 0, false, true)
})
it('reconstructs one review record after a crash immediately after invalid-group rename', async () => {
  await run(0, '', 'write', 'review', false, false, false, false, true)
})
it('D-083 preserves the source backup when the published destination is replaced by an unrelated inode', async () => {
  await run(0, 'settled-move', 'move', 0, true, 'replacement')
}, 120_000)
it('D-083 preserves the backup visibly when a case-only destination replacement occupies the original name', async () => {
  await run(0, 'settled-move', 'move', 0, true, 'replacement', true, true)
}, 120_000)
it('D-084 preserves an in-place edit of a case-only published move on a folding filesystem', async () => {
  await run(0, 'publication', 'move', 0, true, true, true, true)
}, 120_000)

// Partition the identical exhaustive matrix, rather than charging thousands of
// nested restarts to one wall-clock timeout. No lifecycle/recovery cut is sampled.
for (const [caseOnly, fold] of [
  [false, false],
  [true, true],
] as const)
  for (const mode of ['write', 'remove', 'move'] as const)
    describe(`group ${mode} (${fold ? 'folding case-only' : 'native'}) converges after every lifecycle await and every nested recovery await`, () => {
      let count = 0
      const covered = new Set<number>()
      // Retained publication ownership adds lifecycle awaits to writes. Keep
      // every cut and the eight-cuts-per-test bound by adding partitions.
      const partitions = mode === 'write' ? 80 : 64
      beforeAll(async () => {
        count = await run(0, '', mode, 0, false, false, caseOnly, fold)
        expect(count).toBeGreaterThan(0)
        expect(
          Math.ceil(count / partitions),
          'bounded lifecycle cuts per test'
        ).toBeLessThanOrEqual(8)
      }, 60_000)
      for (let part = 0; part < partitions; part++)
        it(`lifecycle partition ${part + 1}/${partitions}`, async ({ signal }) => {
          const first = Math.floor((part * count) / partitions) + 1
          const last = Math.floor(((part + 1) * count) / partitions)
          expect(last - first + 1, 'bounded lifecycle cuts per test').toBeLessThanOrEqual(8)
          for (let cut = first; cut <= last; cut++) {
            try {
              await run(cut, '', mode, 0, true, false, caseOnly, fold, false, signal)
              covered.add(cut)
            } catch (error) {
              throw new Error(`group restart failed at await ${cut}/${count}`, { cause: error })
            }
          }
        }, 60_000)
      afterAll(() => {
        expect(
          [...covered].sort((a, b) => a - b),
          'every lifecycle await remains covered'
        ).toEqual(Array.from({ length: count }, (_, i) => i + 1))
        console.info(
          `Group ${mode} recovery replayed ${count} lifecycle awaits; ${recoveryImages.size} distinct recovery images`
        )
      })
    })

it('publication recovery bounds scratch buffers for an eight-byte victim', async ({ signal }) => {
  recoveryImages.clear() // Exercise the nested trace even when the matrix ran first.
  let allocated = 0
  const alloc = Buffer.alloc
  const spy = vi
    .spyOn(Buffer, 'alloc')
    .mockImplementation((...args: Parameters<typeof Buffer.alloc>) => {
      allocated += args[0]
      return alloc(...args)
    })
  try {
    await run(0, 'publication', 'write', 0, true, false, false, false, false, signal)
    expect(allocated).toBeLessThan(16 * 1024 * 1024)
  } finally {
    spy.mockRestore()
  }
}, 60000)
