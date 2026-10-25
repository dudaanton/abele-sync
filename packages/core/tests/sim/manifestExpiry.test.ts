import { expect, it } from 'vitest'
import { AbeleError, type ChangeItem, type ManifestItem } from '@abele/sync-protocol'
import {
  MemoryFileSystem,
  MemoryStateStore,
  ExpectedWrites,
  sha256,
  pull,
  type EngineClient,
} from '../../src/index.js'

it.each([
  { changed: false, reload: false },
  { changed: true, reload: false },
  { changed: true, reload: true },
])(
  'restarts expired inventory without duplicate content or a lost feed interval (changed=$changed, reload=$reload)',
  async ({ changed, reload }) => {
    let now = 0,
      head = 10,
      starts = 0,
      expired = 0
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = Array.from({ length: 8 }, (_, n) => new Uint8Array([n]))
    let live: Array<ManifestItem & ChangeItem> = await Promise.all(
      bytes.map(async (b, n) => ({
        file_id: `f${n}`,
        version_id: `v${n}`,
        path: `${n}.bin`,
        sha: await sha256(b),
        size: 1,
        mtime: 1,
        seq: 10,
        op: 'create' as const,
        prev_path: null,
        kind: 'attachment' as const,
        actor: { kind: 'system' as const, id: 'test', name: 'test' },
        at: '',
      }))
    )
    const original = [...live],
      snapshots = new Map<number, { at: number; items: typeof live; head: number }>()
    const downloads = new Map<string, number>()
    const changes: ChangeItem[] = []
    const client = {
      manifest: async (cursor: string | null) => {
        let id: number, offset: number
        if (cursor === null) {
          id = ++starts
          offset = 0
          snapshots.set(id, { at: now, items: [...live], head })
        } else [id, offset] = cursor.split(':').map(Number) as [number, number]
        const snapshot = snapshots.get(id)!
        if (now - snapshot.at >= 3600000) {
          expired++
          if (changed && head === 10) {
            head = 12
            const equal = {
              ...original[0]!,
              version_id: 'equal-new-version',
              seq: 11,
              op: 'modify' as const,
            }
            changes.push(equal, {
              ...original[1]!,
              seq: 12,
              op: 'delete',
              sha: null,
              size: null,
              mtime: null,
            })
            live = [equal, ...live.slice(2)]
          }
          throw new AbeleError('invalid_request', 'invalid or expired page cursor')
        }
        return {
          items: snapshot.items.slice(offset, offset + 2),
          head_seq: snapshot.head,
          next: offset + 2 < snapshot.items.length ? `${id}:${offset + 2}` : null,
        }
      },
      changes: async (since: number) => ({
        items: changes.filter((c) => c.seq > since),
        next_since: head,
        head_seq: head,
      }),
      getBlob: async (sha: string) => {
        downloads.set(sha, (downloads.get(sha) ?? 0) + 1)
        now += 40 * 60000 // Applying a page can take longer than the snapshot lease.
        return bytes[original.findIndex((item) => item.sha === sha)]!
      },
    } as unknown as EngineClient
    if (reload) {
      const controller = new AbortController(),
        write = fs.conditionalFile.bind(fs)
      let installed = 0
      fs.conditionalFile = async (op) => {
        const result = await write(op)
        if (++installed === 2) controller.abort()
        return result
      }
      await expect(
        pull(client, fs, state, {
          expected: new ExpectedWrites(),
          dirty: new Set(),
          filter: { excluded: () => false },
          prefetchBytes: 0,
          signal: controller.signal,
        })
      ).rejects.toThrow('sync stopped')
      fs.conditionalFile = write
      expect(await state.getMeta('pull-manifest-progress')).not.toBeNull()
    }
    await pull(client, fs, state, {
      expected: new ExpectedWrites(),
      dirty: new Set(),
      filter: { excluded: () => false },
      prefetchBytes: 0,
    })
    expect(now).toBeGreaterThan(3600000)
    expect(expired).toBeGreaterThan(0)
    expect(starts).toBeGreaterThan(1)
    expect([...downloads.values()]).toEqual(Array(8).fill(1))
    expect(await state.getCursor()).toBe(head)
    for (const item of live)
      expect(await fs.read(item.path)).toEqual(bytes[Number(item.file_id.slice(1))])
    if (changed) {
      expect(await state.byFileId('f0')).toMatchObject({ versionId: 'equal-new-version' })
      expect(await fs.stat('1.bin')).toBeNull()
    }
    expect(await state.getMeta('pull-manifest-progress')).toBeNull()
  }
)

it.each(['corrupt', 'corrupt-stalled', 'stalled', 'churn'] as const)(
  'bounds expired inventory work and retains held results (%s)',
  async (mode) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
    const items = await Promise.all(
      bytes.map(async (b, i) => ({
        file_id: `f${i}`,
        version_id: `v${i}`,
        path: `${i}.bin`,
        sha: await sha256(b),
        size: 1,
        mtime: 1,
        seq: 10,
        kind: 'attachment' as const,
      }))
    )
    const untouched = new Uint8Array([77])
    await fs.writeAtomic('unseen.bin', untouched, 1)
    const stat = (await fs.stat('unseen.bin'))!
    await state.put({
      path: 'unseen.bin',
      wirePath: 'unseen.bin',
      fileId: 'unseen',
      versionId: 'unseen-version',
      sha: await sha256(untouched),
      size: stat.size,
      mtime: stat.mtime,
    })
    let now = 0,
      created = 0,
      starts = 0,
      downloads = 0
    let forceExpiry = mode !== 'corrupt'
    const counts = new Map<string, number>()
    const client = {
      manifest: async (next: string | null) => {
        if (next === null) {
          // Fail promptly on the old infinite loop, without relying on a timeout.
          expect(++starts).toBeLessThanOrEqual(12)
          created = now
          const first =
            mode === 'churn'
              ? [
                  {
                    ...items[0]!,
                    file_id: `new${starts}`,
                    version_id: `new${starts}`,
                    path: `new${starts}.bin`,
                  },
                ]
              : items.slice(0, 2)
          return { items: first, head_seq: 10, next: 'tail' }
        }
        if (forceExpiry || now - created >= 3600000)
          throw new AbeleError('invalid_request', 'invalid or expired page cursor')
        return { items: items.slice(2), head_seq: 10, next: null }
      },
      changes: async () => ({ items: [], next_since: 10, head_seq: 10 }),
      getBlob: async (sha: string) => {
        downloads++
        counts.set(sha, (counts.get(sha) ?? 0) + 1)
        now += 40 * 60000
        return mode.startsWith('corrupt') && sha !== items[2]!.sha
          ? new Uint8Array([99])
          : bytes[items.findIndex((i) => i.sha === sha)]!
      },
    } as unknown as EngineClient
    const report = await pull(client, fs, state, {
      expected: new ExpectedWrites(),
      dirty: new Set(),
      filter: { excluded: () => false },
      prefetchBytes: 100,
      recheck: new Set(['unseen']),
    })
    expect(starts).toBeGreaterThan(1)
    expect(starts).toBeLessThanOrEqual(9)
    if (mode === 'corrupt') {
      expect(report.held.map((c) => c.file_id).sort()).toEqual(['f0', 'f1'])
      expect([...counts.values()]).toEqual([1, 1, 1])
      expect(await fs.read('2.bin')).toEqual(bytes[2])
    } else {
      expect(report.cursor).toBe(0)
      expect(await state.getMeta('pull-manifest-progress')).not.toBeNull()
      // Churn changes identity and path, but still reuses the same content hash.
      expect(downloads).toBe(mode === 'churn' ? 1 : 2)
      if (mode === 'corrupt-stalled')
        expect(report.held.map((c) => c.file_id).sort()).toEqual(['f0', 'f1'])
      // A partial inventory must never treat unseen recheck entries as deleted.
      expect(JSON.parse((await state.getMeta('pull-held-progress'))!).inventoryComplete).toBe(false)
      expect(await fs.read('unseen.bin')).toEqual(untouched)
      expect(await state.byFileId('unseen')).not.toBeNull()
      if (mode === 'stalled') {
        forceExpiry = false
        const resumed = await pull(client, fs, state, {
          expected: new ExpectedWrites(),
          dirty: new Set(),
          filter: { excluded: () => false },
          prefetchBytes: 100,
        })
        expect(resumed.cursor).toBe(10)
        expect(downloads).toBe(3)
        expect(await fs.read('2.bin')).toEqual(bytes[2])
      }
    }
  }
)
