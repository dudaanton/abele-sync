import { expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { pull } from '../../src/puller.js'
import type { EngineClient } from '../../src/engineClient.js'
import { DurableStateStore } from './durableState.js'
import { SimScheduler, EpochError } from './scheduler.js'

// Keep every crash cut, with an independent budget for each deterministic seed.
it.each([1, 2, 3, 4, 5, 6, 7, 8])(
  'identity heads match raw feed application across random pages and every crash boundary (seed %i)',
  async (seed) => {
    const random = new SimScheduler(seed)
    const live = new Map<string, ChangeItem>(),
      events: ChangeItem[] = []
    const blobs = new Map<string, Uint8Array>()
    const initial: ChangeItem[] = []
    for (let n = 0; n < 2; n++) {
      const bytes = new Uint8Array([100 + n]),
        sha = await sha256(bytes)
      blobs.set(sha, bytes)
      const entry: ChangeItem = {
        file_id: `id-${n}`,
        seq: 1,
        version_id: `initial-${n}`,
        op: 'create',
        path: `${n === 0 ? 'a' : 'b'}.bin`,
        prev_path: null,
        sha,
        size: 1,
        mtime: 1,
        kind: 'attachment',
        actor: { kind: 'system', id: 'test', name: 'test' },
        at: '',
      }
      initial.push(entry)
      live.set(entry.file_id, entry)
    }
    for (let n = 0; n < 20; n++) {
      const id = `id-${Math.floor(random.random() * 4)}`
      const old = live.get(id)
      const free = ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'A.bin'].filter(
        (path) => ![...live.values()].some((c) => c.path === path && c.file_id !== id)
      )
      const op = !old
        ? 'create'
        : (['modify', 'move', 'delete'] as const)[Math.floor(random.random() * 3)]!
      const bytes = new Uint8Array([n + 1]),
        sha = await sha256(bytes)
      blobs.set(sha, bytes)
      const change: ChangeItem = {
        file_id: id,
        seq: n + 2,
        version_id: `v${n}`,
        op,
        path:
          op === 'create' || op === 'move'
            ? free[Math.floor(random.random() * free.length)]!
            : old!.path,
        prev_path: op === 'move' ? old!.path : null,
        sha: op === 'delete' ? null : sha,
        size: op === 'delete' ? null : 1,
        mtime: op === 'delete' ? null : n + 1,
        kind: 'attachment',
        actor: { kind: 'system', id: 'test', name: 'test' },
        at: '',
      }
      events.push(change)
      if (op === 'delete') live.delete(id)
      else live.set(id, change)
    }
    const pages: ChangeItem[][] = []
    for (let at = 0; at < events.length;) {
      const size = 1 + Math.floor(random.random() * 4)
      pages.push(events.slice(at, at + size))
      at += size
    }
    const execute = async (raw: boolean, cut?: string) => {
      const scheduler = new SimScheduler(seed),
        fs = new MemoryFileSystem()
      let state = new DurableStateStore(scheduler)
      for (const entry of initial) {
        await fs.writeAtomic(entry.path, blobs.get(entry.sha!)!, 1)
        await state.put({
          fileId: entry.file_id,
          versionId: entry.version_id,
          path: entry.path,
          wirePath: entry.path,
          sha: entry.sha!,
          size: 1,
          mtime: 1,
        })
      }
      await state.setCursor(1)
      const start = scheduler.points.length
      scheduler.cut = cut
      let head = raw ? 1 : events.at(-1)!.seq
      const client = {
        changes: async (since: number) => {
          await scheduler.point('feed.before')
          const candidates = raw
            ? events.filter((c) => c.seq > since && c.seq <= head).slice(0, 1)
            : (pages.find((page) => page.at(-1)!.seq > since) ?? []).filter((c) => c.seq > since)
          await scheduler.point('feed.after')
          return { items: candidates, next_since: candidates.at(-1)?.seq ?? head, head_seq: head }
        },
        getBlob: async (sha: string) => blobs.get(sha)!,
      } as unknown as EngineClient
      const run = () =>
        pull(client, fs, state, {
          expected: new ExpectedWrites(),
          dirty: new Set(),
          filter: { excluded: () => false },
        })
      try {
        if (raw)
          for (const event of events) {
            head = event.seq
            await run()
          }
        else await run()
      } catch (error) {
        if (!(error instanceof EpochError)) throw error
        state = state.reopen()
        scheduler.cut = undefined
        await run()
      }
      const points = scheduler.points.slice(start)
      scheduler.cut = undefined
      const image = []
      for await (const entry of state.all())
        image.push([entry.fileId, entry.path, [...(await fs.read(entry.path))]])
      const files = []
      for await (const file of fs.list()) files.push([file.path, [...(await fs.read(file.path))]])
      expect(files.sort(), `seed ${seed}, cut ${cut}, raw ${raw}`).toEqual(
        image.map(([, path, bytes]) => [path, bytes]).sort()
      )
      expect(await state.getCursor()).toBe(events.at(-1)!.seq)
      return { image: image.sort(), points }
    }
    const raw = await execute(true),
      complete = await execute(false)
    expect(complete.image, `seed ${seed}`).toEqual(raw.image)
    for (const cut of complete.points) {
      if (cut === 'state.setCursor#1') continue
      expect((await execute(false, cut)).image, `seed ${seed}, ${cut}`).toEqual(raw.image)
    }
  },
  20000
)
