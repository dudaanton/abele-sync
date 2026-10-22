import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
                if (name === 'open') crash.handles.add(result)
                return result
              }
            )
            if (name !== 'open') return value
            return new Proxy(value as object, {
              get(target, key) {
                const method = Reflect.get(target, key, target)
                return typeof method !== 'function'
                  ? method
                  : (...params: unknown[]) =>
                      boundary(`handle.${String(key)}:${String(args[0])}`, async () => {
                        const result = await method.apply(target, params)
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

async function run(
  cut = 0,
  exact: 'capture' | 'publication' | 'first-save' | '' = '',
  mode: 'write' | 'remove' | 'move' = 'write',
  recoveryCut: number | 'restoring' = 0
) {
  const dir = await mkdtemp(join(tmpdir(), 'group-cut-'))
  const disk = new NodeFileSystem(dir),
    state = SqliteStateStore.open(join(dir, '.abele-sync/state.db'))
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
    for (const handle of crash.handles) await handle.close()
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
      for (const handle of crash.handles) await handle.close()
      crash.handles.clear()
    }
    // Restart composition, not an artificially reordered sequence of helpers.
    await recoverNodeReplica(vault as NodeReplica, () => true)
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
    await checkImage()
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
    await recoverNodeReplica(vault as NodeReplica, () => true)
    await checkImage()
    return count
  } finally {
    crash.armed = false
    crash.dead = false
    for (const handle of crash.handles) await handle.close()
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

it('group restart converges without hidden or leaked objects after every filesystem await', async () => {
  const count = await run()
  expect(count).toBeGreaterThan(0)
  for (let cut = 1; cut <= count; cut++) {
    try {
      await run(cut)
    } catch (error) {
      throw new Error(`group restart failed at await ${cut}/${count}`, { cause: error })
    }
  }
  console.info(`Group write recovery replayed ${count} filesystem await boundaries`)
}, 90_000)
