import { expect, it } from 'vitest'
import fc from 'fast-check'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore, type StateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { pull } from '../../src/puller.js'
import { PullHolds } from '../../src/pullHolds.js'
import type { EngineClient } from '../../src/engineClient.js'

it('every crash boundary preserves accepted, refused and held events in random orders', async () => {
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  await fc.assert(
    fc.asyncProperty(
      fc.shuffledSubarray(['accepted', 'refused', 'held', 'delete'] as const, {
        minLength: 4,
        maxLength: 4,
      }),
      fc.boolean(),
      async (order, inventory) => {
        const changes: ChangeItem[] = order.map((mode, i) => ({
          seq: i + 2,
          file_id: mode,
          path: `${mode}.bin`,
          version_id: 'v2',
          kind: 'attachment',
          op: mode === 'delete' ? 'delete' : 'modify',
          prev_path: null,
          sha: mode === 'delete' ? null : sha,
          size: mode === 'delete' ? null : 1,
          mtime: mode === 'delete' ? null : 2,
          actor: { kind: 'system', id: 'test', name: 'test' },
          at: '',
        }))
        async function replay(cut: number) {
          const fs = new MemoryFileSystem(),
            state = new MemoryStateStore()
          const base = new Uint8Array([0]),
            baseSha = await sha256(base)
          for (const change of changes) {
            await fs.writeAtomic(change.path, base, 1)
            await state.put({
              fileId: change.file_id,
              path: change.path,
              wirePath: change.path,
              versionId: 'v1',
              sha: baseSha,
              size: 1,
              mtime: 1,
            })
          }
          await state.setCursor(inventory ? 0 : 1)
          let boundaries = 0,
            dead = false,
            policy = true
          const crash = new Error('simulated crash')
          const boundary = () => {
            if (++boundaries === cut) dead = true
            if (dead) throw crash
          }
          // Include transaction-scoped reads/writes, publication, filesystem effects,
          // and client awaits. A fresh pull gets only the committed state after a cut.
          function instrument<T extends object>(target: T): T {
            return new Proxy(target, {
              get(object, key) {
                const value = Reflect.get(object, key)
                if (typeof value !== 'function') return value
                if (key === 'transaction')
                  return async (fn: (tx: StateStore) => Promise<unknown>) => {
                    if (dead) throw crash
                    const result = await value.call(object, (tx: StateStore) => fn(instrument(tx)))
                    boundary()
                    return result
                  }
                return (...args: unknown[]) => {
                  if (dead) throw crash
                  const result = value.apply(object, args)
                  if (result?.[Symbol.asyncIterator]) {
                    const iterator = result[Symbol.asyncIterator]()
                    return {
                      [Symbol.asyncIterator]() {
                        return this
                      },
                      async next() {
                        if (dead) throw crash
                        const answer = await iterator.next()
                        boundary()
                        return answer
                      },
                    }
                  }
                  if (!(result instanceof Promise)) return result
                  return result.then((answer: unknown) => {
                    boundary()
                    return answer
                  })
                }
              },
            })
          }
          const client = {
            pathRefusal: (path: string) =>
              policy && /^(refused|delete)/.test(path)
                ? { code: 'leaves_scope', message: 'policy' }
                : undefined,
            manifest: async () => ({
              items: changes.map((c) => ({
                ...c,
                seq: 1,
                op: 'create',
                version_id: 'v1',
                sha: baseSha,
                size: 1,
                mtime: 1,
              })),
              next: null,
              head_seq: 1,
            }),
            changes: async (since: number) => ({
              items: changes.filter((c) => c.seq > since),
              next_since: 5,
              head_seq: 5,
            }),
            getBlob: async () => bytes,
          } as unknown as EngineClient
          const options = {
            expected: new ExpectedWrites(),
            dirty: new Set(['held.bin']),
            filter: { excluded: () => false },
          }
          try {
            await pull(instrument(client), instrument(fs), instrument(state), options)
          } catch (error) {
            if (error !== crash) throw error
          }
          const cursor = await state.getCursor(),
            holds = new PullHolds(state),
            refused = new PullHolds(
              state,
              'pull-refused-progress',
              (id) => `pull-refused:${encodeURIComponent(id)}`
            )
          await holds.load()
          await refused.load()
          for (const change of changes) {
            if (change.seq > cursor) continue
            const entry = await state.byFileId(change.file_id)
            const applied = change.op === 'delete' ? entry === null : entry?.versionId === 'v2'
            expect(
              applied || holds.files.has(change.file_id) || refused.files.has(change.file_id),
              `cut ${cut}, cursor ${cursor}, ${change.file_id}`
            ).toBe(true)
          }
          policy = false
          options.dirty.clear()
          // Rewind discards live inventory but must retain refused deletes.
          if (inventory) await state.setCursor(0)
          await pull(client, fs, state, options)
          for (const change of changes) {
            if (change.op === 'delete') expect(await fs.stat(change.path)).toBeNull()
            else expect(await fs.read(change.path)).toEqual(bytes)
          }
          return boundaries
        }
        const count = await replay(Infinity)
        for (let cut = 1; cut <= count; cut++) await replay(cut)
      }
    ),
    { seed: 136137, numRuns: 8 }
  )
}, 30000)
