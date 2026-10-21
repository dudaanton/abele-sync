import { expect, it, vi } from 'vitest'
import { ExpectedWrites } from '../../src/echo.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { sha256 } from '../../src/hash.js'
import { scan } from '../../src/scanner.js'
import { push, resumeJournal } from '../../src/pusher.js'
import { stoppableClient } from '../../src/guard.js'
import type { EngineClient } from '../../src/engineClient.js'

it('cancelling a later receipt download commits earlier file ledgers and replays the remaining receipt', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  const bytes = ['R0', 'R1'].map((s) => new TextEncoder().encode(s))
  const shas = await Promise.all(bytes.map((b) => sha256(b)))
  for (let n = 0; n < 2; n++) await fs.writeAtomic(`${n}.md`, new TextEncoder().encode(`L${n}`), 1)
  const found = await scan(fs, state, { excluded: () => false })
  let entered!: () => void, release!: () => void
  const reached = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let controller = new AbortController(),
    blocked = true
  const original = {
    hasBlob: async () => true,
    getBlob: vi.fn(async (sha: string) => {
      if (sha === shas[1] && blocked) {
        entered()
        await gate
      }
      return bytes[shas.indexOf(sha)]!
    }),
    commitRaw: vi.fn(async () => ({
      replayed: true,
      body: {
        head_seq: 2,
        results: shas.map((sha, n) => ({
          status: 'merged' as const,
          file_id: `f${n}`,
          version_id: `v${n}`,
          seq: n + 1,
          path: `${n}.md`,
          sha,
          size: 2,
          mtime: 2,
        })),
      },
    })),
  } as unknown as EngineClient
  const client = stoppableClient(original, () => controller.signal, { count: 0 })
  const expected = new ExpectedWrites()
  const running = push(client, fs, state, found, {
    expected,
    prefetchBytes: 2,
    signal: controller.signal,
  })
  const cancelled = expect(running).rejects.toMatchObject({ code: 'offline' })
  await reached
  controller.abort()
  await cancelled
  expect(await fs.read('0.md')).toEqual(bytes[0])
  expect(await state.get('0.md')).toMatchObject({ sha: shas[0], versionId: 'v0' })
  expect(await state.get('1.md')).toBeNull()
  const journal = await state.getJournal()
  expect(journal).not.toBeNull()
  blocked = false
  release()
  controller = new AbortController()
  await resumeJournal(client, fs, state, { expected, prefetchBytes: 2, signal: controller.signal })
  expect(await state.getJournal()).toBeNull()
  expect(await state.get('1.md')).toMatchObject({ sha: shas[1], versionId: 'v1' })
  expect(await fs.read('1.md')).toEqual(bytes[1])
  expect(original.commitRaw).toHaveBeenLastCalledWith(journal!.ops, journal!.idempotencyKey)
  expect(vi.mocked(original.getBlob).mock.calls.filter(([sha]) => sha === shas[0])).toHaveLength(1)
})
