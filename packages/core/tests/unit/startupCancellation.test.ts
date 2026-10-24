import { expect, it, vi } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { recoverRemovals } from '../../src/removalRetention.js'
import { shaIndex } from '../../src/apply.js'
import { scanSnapshot } from '../../src/scanSnapshot.js'
import { selectiveDefaults } from '../../src/selective.js'
import { SyncEngine } from '../../src/engine.js'
import type { EngineClient } from '../../src/engineClient.js'

it('33k engine.pause fences requests and vault writes during every cycle state traversal', async () => {
  const exercise = async (target?: number) => {
    const { fs, state } = await fixture(33000)
    await state.setCursor(1)
    const all = state.all.bind(state)
    let passes = 0,
      active: number | undefined,
      paused: number | undefined
    let afterPauseWrites = 0
    const requests: number[] = []
    state.all = async function* () {
      active = ++passes
      try {
        yield* all()
      } finally {
        active = undefined
      }
    }
    for (const name of ['writeAtomic', 'move', 'remove', 'conditionalFile'] as const) {
      const method = fs[name].bind(fs)
      Object.assign(fs, {
        [name]: (...args: unknown[]) => {
          if (paused !== undefined) afterPauseWrites++
          return Reflect.apply(method, fs, args)
        },
      })
    }
    const engine = new SyncEngine({
      fs,
      state,
      selective: scope.selective,
      yieldTask: async () => {
        if (target !== undefined && active === target && paused === undefined) {
          paused = performance.now()
          engine.pause()
        }
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel()
          channel.port1.onmessage = () => {
            channel.port1.close()
            channel.port2.close()
            resolve()
          }
          channel.port2.postMessage(null)
        })
      },
      client: {
        state: async () => {
          requests.push(performance.now())
          return { head_seq: 1, settings: { max_file_bytes: 10000, quota_bytes: null } }
        },
        changes: async () => {
          requests.push(performance.now())
          return { items: [], next_since: 1, head_seq: 1 }
        },
      } as unknown as EngineClient,
    })
    try {
      await engine.sync().catch((error) => {
        if (paused === undefined) throw error
        expect(error.message).toContain('sync stopped')
      })
      if (target !== undefined) {
        expect(paused, `traversal ${target} was reached`).toBeDefined()
        expect(performance.now() - paused!).toBeLessThan(100)
        expect(requests.filter((time) => time > paused! + 100)).toEqual([])
        expect(afterPauseWrites).toBe(0)
      }
      return passes
    } finally {
      await engine.stop()
    }
  }
  const passes = await exercise()
  expect(passes).toBeGreaterThan(0)
  for (let pass = 1; pass <= passes; pass++) await exercise(pass)
})
import { V2Directories } from '../../src/v2Directories.js'
import { decorateStateTransactions } from '../helpers/stateTransactions.js'
import { scheduledState } from '../../src/guard.js'
import { LocalPaths } from '../../src/localPaths.js'
import { pathOccupant } from '../../src/pathOccupant.js'
import { sourcesFromOps } from '../../src/pushSources.js'

it.each([
  'state',
  'transaction',
  'candidates',
  'sha index',
  'path lookup',
  'siblings',
  'inventory',
  'cached inventory',
  'collisions',
  'push sources',
  'directory document',
] as const)('33k %s traversal yields and cancels before its next effect', async (phase) => {
  const f = await fixture(33000)
  const stop = new AbortController()
  let checkpoints = 0
  const scheduling = {
    signal: stop.signal,
    yieldTask: async () => {
      checkpoints++
      stop.abort()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
  }
  const state = scheduledState(f.state, () => scheduling)
  let run: () => Promise<unknown>
  if (phase === 'state')
    run = async () => {
      for await (const _ of state.all()) {
        /* enumerate */
      }
    }
  else if (phase === 'transaction')
    run = () =>
      state.transaction(async (tx) => {
        for await (const _ of tx!.all()) {
          /* enumerate */
        }
      })
  else if (phase === 'candidates' || phase === 'path lookup') {
    Object.defineProperty(f.state, 'pathCandidates', { value: undefined })
    run =
      phase === 'path lookup'
        ? () => pathOccupant(f.fs, state, 'absent.bin', 'absent')
        : () =>
            state.transaction(async (tx) => {
              for await (const _ of tx!.pathCandidates!('absent.bin')) {
                /* fallback candidates */
              }
            })
  } else if (phase === 'sha index') run = () => shaIndex(state)
  else if (phase === 'siblings') {
    Object.assign(f.fs, {
      listChildren: async () =>
        Array.from({ length: 33000 }, (_, n) => ({ path: `sibling${n}`, kind: 'file' as const })),
    })
    run = () => LocalPaths.forPath(f.fs, 'absent.bin', state)
  } else if (phase === 'inventory') run = () => LocalPaths.read(f.fs, state)
  else if (phase === 'collisions') {
    const inventory = await LocalPaths.read(f.fs, f.state)
    run = () => inventory.directoryCollisions(scheduling)
  } else if (phase === 'push sources') run = () => sourcesFromOps(f.fs, state, [])
  else if (phase === 'directory document') {
    await f.state.setMeta(
      'v2-directories',
      JSON.stringify({
        directories: Array.from({ length: 33000 }, (_, n) => ({
          file_id: `dir${n}`,
          version_id: 'v1',
          kind: 'directory',
          path: `dir${n}`,
          identity: `inode${n}`,
          mtime: 1,
        })),
        removals: [],
      })
    )
    const directories = new V2Directories(
      f.fs,
      state,
      () => true,
      async () => [],
      stop.signal
    )
    run = () => directories.loadRefusals()
  } else {
    let armed = false
    const snapshot = scanSnapshot(f.fs, () => stop.signal, {
      yieldTask: async () => {
        if (armed) await scheduling.yieldTask()
      },
    })
    for await (const _ of snapshot.fs.list()) {
      /* warm the cache */
    }
    armed = true
    run = async () => {
      for await (const _ of snapshot.fs.list()) {
        /* replay */
      }
    }
  }
  let writes = 0
  f.fs.writeAtomic = async () => {
    writes++
    throw new Error('unexpected vault write')
  }
  f.fs.remove = async () => {
    writes++
    throw new Error('unexpected vault removal')
  }
  const before = performance.now()
  await expect(run()).rejects.toThrow('sync stopped')
  expect(checkpoints).toBe(1)
  expect(performance.now() - before).toBeLessThan(100)
  expect(writes).toBe(0)
})

it('D-227 pauses a 33k orphan-removal sweep before any later metadata effect', async () => {
  const { fs, state } = await fixture(33000)
  const stop = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let afterAbort = 0,
    visited = 0
  for (let n = 0; n < 33000; n++) {
    const base = (await state.get(`folder/file${n}.bin`))!
    await state.setMeta(
      `removal-decision:orphan-${n}`,
      JSON.stringify({ id: `orphan-${n}`, base, committed: false })
    )
  }
  decorateStateTransactions(state, (tx) => {
    timer ??= setTimeout(() => stop.abort(), 0)
    const set = tx.setMeta!.bind(tx)
    tx.setMeta = async (key, value) => {
      visited++
      if (stop.signal.aborted) afterAbort++
      await set(key, value)
    }
  })
  try {
    await expect(recoverRemovals(fs, state, { signal: stop.signal })).rejects.toThrow(
      'sync stopped'
    )
    expect(afterAbort).toBe(0)
    expect(visited).toBeLessThan(33000)
  } finally {
    clearTimeout(timer)
  }
})

it('D-228 pauses inside the second 33k recreated-directory deletion pass and rolls it back', async () => {
  const { fs, state } = await fixture(33000)
  const stop = new AbortController()
  Object.assign(fs, {
    async *listDirectories() {
      yield { path: 'folder', identity: 'new', mtime: 2 }
    },
  })
  const doc = {
    directories: [
      {
        file_id: 'dir',
        version_id: 'v1',
        path: 'folder',
        kind: 'directory' as const,
        mtime: 1,
        identity: 'old',
      },
    ],
    removals: [],
    pending: {
      key: 'delete-dir',
      identity: 'old',
      op: { op: 'delete_directory' as const, file_id: 'dir', base_version_id: 'v1' },
    },
  }
  await state.setMeta('v2-directories', JSON.stringify(doc))
  let timer: ReturnType<typeof setTimeout> | undefined
  let afterAbort = 0,
    visited = 0
  decorateStateTransactions(state, (tx) => {
    const remove = tx.delete.bind(tx)
    tx.delete = async (path) => {
      timer ??= setTimeout(() => stop.abort(), 0)
      visited++
      if (stop.signal.aborted) afterAbort++
      await remove(path)
    }
  })
  const directories = new V2Directories(
    fs,
    state,
    () => true,
    async () => [],
    stop.signal
  )
  try {
    await expect(directories.retireRecreatedDelete()).rejects.toThrow('sync stopped')
    expect(afterAbort).toBe(0)
    expect(visited).toBeGreaterThan(0)
    expect(visited).toBeLessThan(33000)
    expect(await state.get('folder/file0.bin')).not.toBeNull()
    expect(JSON.parse((await state.getMeta('v2-directories'))!).pending).toEqual(doc.pending)
  } finally {
    clearTimeout(timer)
  }
})

const scope = { selective: selectiveDefaults(), scriptsFolder: 'Scripts' }
async function fixture(count: number) {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  for (let n = 0; n < count; n++) {
    const path = `folder/file${n}.bin`
    await fs.writeAtomic(path, new Uint8Array([1]), 1)
    await state.put({
      path,
      wirePath: path,
      fileId: path,
      versionId: 'v1',
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
    })
  }
  await state.setMeta('marked-scope', JSON.stringify(scope))
  fs.read = vi.fn(async () => {
    throw new Error('unchanged inventory must not read content')
  })
  const fingerprint = vi.fn(async (path: string) => ({
    ...(await fs.stat(path))!,
    sha: 'a'.repeat(64),
    generation: 'cached',
  }))
  Object.assign(fs, { fingerprint })
  return { fs, state, fingerprint }
}
