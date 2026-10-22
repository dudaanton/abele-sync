import { expect, it } from 'vitest'
import fc from 'fast-check'
import type { ChangeItem } from '@abele/sync-protocol'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore, type StateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { sha256 } from '../../src/hash.js'
import { applyStaged, pull, type PullOptions } from '../../src/puller.js'
import { StagedChanges } from '../../src/defer.js'
import { PullHolds } from '../../src/pullHolds.js'
import type { EngineClient } from '../../src/engineClient.js'

it('every crash boundary preserves accepted, refused, held and staged versions in random orders', async () => {
  const bytes = new Uint8Array([1]),
    sha = await sha256(bytes)
  await fc.assert(
    fc.asyncProperty(
      fc.shuffledSubarray(['accepted', 'refused', 'held', 'delete', 'staged'] as const, {
        minLength: 5,
        maxLength: 5,
      }),
      fc.boolean(),
      async (order, inventory) => {
        const changes: ChangeItem[] = [...order, ...[...order].reverse()].map((mode, i) => ({
          seq: i + 2,
          file_id: mode,
          path: mode === 'staged' ? 'new-staged.bin' : `${mode}.bin`,
          version_id: `v${i + 2}`,
          kind: 'attachment',
          op:
            mode === 'delete'
              ? 'delete'
              : mode === 'staged' && i < order.length
                ? 'move'
                : 'modify',
          prev_path: mode === 'staged' && i < order.length ? 'staged.bin' : null,
          sha: mode === 'delete' ? null : sha,
          size: mode === 'delete' ? null : 1,
          mtime: mode === 'delete' ? null : 2,
          actor: { kind: 'system', id: 'test', name: 'test' },
          at: '',
        }))
        const head = changes.length + 1
        const latest = new Map(changes.map((change) => [change.file_id, change]))
        async function replay(cut: number) {
          const fs = new MemoryFileSystem(),
            state = new MemoryStateStore()
          const base = new Uint8Array([0]),
            baseSha = await sha256(base)
          for (const change of latest.values()) {
            const path = `${change.file_id}.bin`
            await fs.writeAtomic(path, base, 1)
            await state.put({
              fileId: change.file_id,
              path,
              wirePath: path,
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
              items: [...latest.values()].map((c) => ({
                ...c,
                path: `${c.file_id}.bin`,
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
            changes: async (since: number) => {
              const items = changes.filter((c) => c.seq > since).slice(0, 2)
              return { items, next_since: items.at(-1)?.seq ?? head, head_seq: head }
            },
            getBlob: async () => bytes,
          } as unknown as EngineClient
          const stages = new StagedChanges(instrument(state))
          const options: PullOptions = {
            expected: new ExpectedWrites(),
            dirty: new Set(['held.bin']),
            filter: { excluded: () => false },
            defer: (path) => path.includes('staged'),
            onDefer: (items) => stages.stage(items),
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
          const staged = await new StagedChanges(state).list()
          if (cut === Infinity)
            expect(cursor).toBe(Math.min(head, (holds.earliest() ?? head + 1) - 1))
          for (const change of changes) {
            if (change.seq > cursor) continue
            const entry = await state.byFileId(change.file_id)
            const applied =
              change.op === 'delete'
                ? entry === null
                : changes.some(
                    (item) =>
                      item.file_id === change.file_id &&
                      item.seq >= change.seq &&
                      item.version_id === entry?.versionId
                  )
            expect(
              applied ||
                (holds.files.get(change.file_id)?.seq ?? -1) >= change.seq ||
                (refused.files.get(change.file_id)?.seq ?? -1) >= change.seq ||
                staged.some(
                  (item) => item.change.file_id === change.file_id && item.change.seq >= change.seq
                ),
              `cut ${cut}, cursor ${cursor}, ${change.file_id}`
            ).toBe(true)
          }
          policy = false
          options.dirty.clear()
          if (cut === Infinity) {
            // Once the real hold settles, cloned staged moves must no longer pin
            // the cursor behind work already handed durably to the approval store.
            await pull(client, fs, state, {
              ...options,
              onDefer: (items) => new StagedChanges(state).stage(items),
            })
            expect(await state.getCursor()).toBe(head)
          }
          // Rewind discards live inventory but must retain refused deletes.
          if (inventory) await state.setCursor(0)
          const retry = { ...options, defer: undefined, onDefer: undefined }
          await pull(client, fs, state, retry)
          const approvals = new StagedChanges(state)
          await applyStaged(
            client,
            fs,
            state,
            (await approvals.list()).map((item) => item.change),
            retry
          )
          await approvals.drop((await approvals.list()).map((item) => item.change.file_id))
          await pull(client, fs, state, retry)
          expect(await state.getCursor()).toBe(head)
          for (const change of latest.values()) {
            if (change.op === 'delete') expect(await fs.stat(change.path)).toBeNull()
            else {
              expect(await fs.read(change.path)).toEqual(bytes)
              expect((await state.byFileId(change.file_id))?.versionId).toBe(change.version_id)
            }
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
