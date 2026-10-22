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
              () => Reflect.apply(fn, actual, args)
            )
            if (name !== 'open') return value
            return new Proxy(value as object, {
              get(target, key) {
                const method = Reflect.get(target, key, target)
                return typeof method !== 'function'
                  ? method
                  : (...params: unknown[]) =>
                      boundary(`handle.${String(key)}:${String(args[0])}`, () =>
                        method.apply(target, params)
                      )
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

async function run(cut = 0, exact: 'capture' | 'publication' | '' = '') {
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
    const group = await CodeGroupDisk.create(vault, () => true)
    const draft = await CodeDraft.create(disk, group.work)
    await draft.writeAtomic('file.bin', encodeText('approved'), 2)
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
              : label.startsWith('link:') && label.endsWith(`->${join(dir, 'file.bin')}`)
          )
        )
          crash.cut = length
        return length
      }
    }
    let failed = false
    try {
      await state.transaction(() => group.place(draft))
    } catch (error) {
      if (!crash.dead) throw error
      failed = true
    }
    const count = crash.points.length
    crash.armed = false
    crash.dead = false
    expect(failed).toBe(cut > 0 || !!exact)
    if (exact === 'capture') expect(await disk.stat('file.bin')).toBeNull()
    // Restart composition, not an artificially reordered sequence of helpers.
    await recoverNodeReplica(vault as NodeReplica, () => true)
    expect(new TextDecoder().decode(await disk.read('file.bin'))).toBe(
      failed ? 'original' : 'approved'
    )
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
    expect(new TextDecoder().decode(await disk.read('file.bin'))).toBe(
      failed ? 'original' : 'approved'
    )
    return count
  } finally {
    crash.armed = false
    crash.dead = false
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
