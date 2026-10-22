import { afterEach, expect, it, vi } from 'vitest'
import { MemoryStateStore, type EngineClient, type FileSystem } from '@abele/sync-core'
import { guarded, stoppableListings } from '../../../core/src/guard.js'
import { scanSnapshot } from '../../../core/src/scanSnapshot.js'
import { SettlingFileSystem, type SettleableFileSystem } from '../../src/growing.js'
import { NodeFileSystem } from '../../src/nodeFs.js'

const info = { path: 'file.bin', size: 1, mtime: 2 }
const base = { size: 1, mtime: 2, sha: 'a'.repeat(64) }
const stamp = { size: 1, mtime: 2, generation: 'source' }
const signal = new AbortController().signal
const beforeCreate = async (_id: string) => {}
const bytes = new Uint8Array([1])
const stop = () => {}
const stage = { id: 'stage' }
const source = { size: 1, stamp }
const operation = {
  path: 'file.bin',
  expected: base,
  effect: { kind: 'write', bytes, mtime: 3, receipt: 'receipt' },
}

const methods: Array<{
  name: keyof FileSystem
  args: unknown[]
  result: unknown
  iterable?: boolean
}> = [
  { name: 'pathKey', args: ['NOTE.bin'], result: 'note.bin' },
  { name: 'list', args: [], result: [info], iterable: true },
  {
    name: 'listDirectories',
    args: [],
    result: [{ path: 'folder', identity: 'directory', mtime: 2 }],
    iterable: true,
  },
  { name: 'listChildren', args: ['folder'], result: [{ path: 'folder/file.bin', kind: 'file' }] },
  { name: 'mkdir', args: ['folder'], result: undefined },
  { name: 'moveDirectory', args: ['old', 'new'], result: undefined },
  { name: 'removeDirectory', args: ['folder', 'inventoried-directory'], result: undefined },
  { name: 'read', args: ['file.bin'], result: bytes },
  { name: 'writeAtomic', args: ['file.bin', bytes, 3], result: undefined },
  { name: 'move', args: ['old.bin', 'new.bin'], result: undefined },
  { name: 'remove', args: ['file.bin'], result: undefined },
  { name: 'stat', args: ['file.bin'], result: info },
  { name: 'watch', args: [(_paths: string[]) => {}], result: stop },
  { name: 'openRead', args: ['file.bin', stamp], result: source },
  { name: 'fingerprint', args: ['file.bin', signal], result: { ...stamp, sha: base.sha } },
  { name: 'beginAtomicWrite', args: ['file.bin', 3, base, beforeCreate], result: stage },
  { name: 'reopenStage', args: ['stage'], result: stage },
  { name: 'discardStage', args: ['stage'], result: undefined },
  { name: 'conditionalFile', args: [operation], result: false },
  { name: 'installedFile', args: ['receipt', 'file.bin', base.sha], result: true },
  { name: 'discardInstallation', args: ['receipt'], result: undefined },
  { name: 'recoverConditionalFiles', args: [], result: undefined },
]

const wrappers = [
  {
    name: 'settling',
    wrap: (disk: SettleableFileSystem): FileSystem => new SettlingFileSystem(disk),
  },
  {
    name: 'ownership',
    wrap: (disk: SettleableFileSystem): FileSystem =>
      guarded({ fs: disk, client: {} as EngineClient, state: new MemoryStateStore() }, () => true)
        .fs,
  },
  {
    name: 'cancellation',
    wrap: (disk: SettleableFileSystem): FileSystem => stoppableListings(disk, () => signal),
  },
  {
    name: 'scan snapshot',
    wrap: (disk: SettleableFileSystem): FileSystem => scanSnapshot(disk, () => signal).fs,
  },
]

for (const wrapper of wrappers)
  it.each(methods)(
    `${wrapper.name} forwards $name arguments, receiver and result`,
    async ({ name, args, result, iterable }) => {
      const disk = { sizeStable: async () => true } as unknown as SettleableFileSystem
      const calls = new Map<string, ReturnType<typeof vi.fn>>()
      for (const method of methods) {
        const call = vi.fn(function (this: SettleableFileSystem, ..._args: unknown[]) {
          expect(this).toBe(disk)
          return method.iterable
            ? (async function* () {
                yield* method.result as unknown[]
              })()
            : method.result
        })
        calls.set(method.name, call)
        Reflect.set(disk, method.name, call)
      }
      const fs = wrapper.wrap(disk)
      const forward = Reflect.get(fs, name) as (...args: unknown[]) => unknown
      expect(forward).toBeTypeOf('function')
      const returned = Reflect.apply(forward, fs, args)
      if (iterable) {
        const items = []
        for await (const item of returned as AsyncIterable<unknown>) items.push(item)
        expect(items).toEqual(result)
      } else if (
        wrapper.name === 'ownership' &&
        (name === 'beginAtomicWrite' || name === 'reopenStage')
      ) {
        // Ownership checks intentionally wrap the stage, preserving its identity fields.
        const guardedStage = (await returned) as typeof stage
        expect(guardedStage).not.toBe(result)
        expect(guardedStage.id).toBe(stage.id)
      } else expect(await returned).toBe(result)
      const call = calls.get(name)!
      expect(call).toHaveBeenCalledExactlyOnceWith(...args)
      for (let i = 0; i < args.length; i++) expect(call.mock.calls[0]![i]).toBe(args[i])
    }
  )

const optional = methods
  .map(({ name }) => name)
  .filter((name) => !['list', 'read', 'writeAtomic', 'move', 'remove', 'stat'].includes(name))
for (const wrapper of wrappers)
  it.each(optional)(`${wrapper.name} does not advertise absent optional capability %s`, (name) => {
    const disk = {
      sizeStable: async () => true,
      async *list() {},
      read: async () => bytes,
      writeAtomic: async () => {},
      move: async () => {},
      remove: async () => {},
      stat: async () => null,
    }
    expect(Reflect.get(wrapper.wrap(disk), name)).toBeUndefined()
  })

afterEach(() => vi.restoreAllMocks())

const tracked = new Set<keyof FileSystem>([
  'conditionalFile',
  'recoverConditionalFiles',
  'discardInstallation',
  'writeAtomic',
  'move',
  'remove',
  'mkdir',
  'removeDirectory',
  'moveDirectory',
])
it.each(methods.filter(({ name }) => tracked.has(name)))(
  'Node effect tracker forwards $name arguments and receiver',
  async ({ name, args, result }) => {
    const prototype = NodeFileSystem.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >
    let disk: NodeFileSystem
    const call = vi.spyOn(prototype, name).mockImplementation(function (this: NodeFileSystem) {
      expect(this).toBe(disk)
      return Promise.resolve(result)
    })
    const track = vi.fn()
    disk = new NodeFileSystem('.', {
      effectTracker: (work) => {
        track()
        return work()
      },
    })
    expect(
      await Reflect.apply(Reflect.get(disk, name) as (...args: unknown[]) => unknown, disk, args)
    ).toBe(result)
    expect(track).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledExactlyOnceWith(...args)
    for (let i = 0; i < args.length; i++) expect(call.mock.calls[0]![i]).toBe(args[i])
  }
)
