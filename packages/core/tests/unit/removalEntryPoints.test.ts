import { expect, it } from 'vitest'
import { encodeAccessToken, type ChangeItem } from '@abele/sync-protocol'
import {
  ExpectedWrites,
  MemoryFileSystem,
  MemoryStateStore,
  V2EngineClient,
  sha256,
} from '../../src/index.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { PushDisk } from '../../src/pushDisk.js'
import { captureDepartures, dispatchDepartures } from '../../src/departureSettlement.js'
import { recoverRemovals } from '../../src/removalRetention.js'
import type { ResumeOptions } from '../../src/pusher.js'

// Every public file-removal entry point, not only the primitive's direct callers.
it.each(['pull-delete', 'pull-source', 'pull-eviction', 'push-source', 'departure'] as const)(
  '%s preserves an equal-byte owner installed during the quarantined content read',
  async (kind) => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore(),
      bytes = new Uint8Array([1])
    const base = {
      path: 'a.md',
      wirePath: 'a.md',
      fileId: 'a',
      versionId: 'v',
      size: 1,
      mtime: 1,
      sha: await sha256(bytes),
    }
    const replacement = { ...base, fileId: 'new-owner', versionId: 'new-version' }
    await fs.writeAtomic(base.path, bytes, 1)
    await state.put(base)
    await state.setCursor(1)
    if (kind === 'pull-source' || kind === 'push-source') await fs.writeAtomic('b.md', bytes, 1)
    let injected = false
    let replace!: () => void
    // A separate host task, not an accidental root write from the tx callback.
    const replacementTask = new Promise<void>((resolve) => {
      replace = resolve
    }).then(() => state.put(replacement))
    const read = fs.read.bind(fs)
    fs.read = async (path) => {
      if (
        !injected &&
        path.startsWith('.abele-sync/retained-removals/') &&
        path.endsWith('/victim')
      ) {
        injected = true
        replace()
        await replacementTask
      }
      return read(path)
    }
    const opts = {
      dirty: new Set<string>(),
      expected: new ExpectedWrites(),
      filter: { excluded: () => false },
    }
    const placer = new PullPlacer({ getBlob: async () => bytes }, fs, state, opts, sha256)
    const change: ChangeItem = {
      seq: 2,
      file_id: kind === 'pull-eviction' ? 'incoming' : base.fileId,
      version_id: 'next',
      path: kind === 'pull-source' ? 'b.md' : base.path,
      prev_path: kind === 'pull-source' ? base.path : null,
      op: kind === 'pull-source' ? 'move' : 'create',
      sha: base.sha,
      size: 1,
      mtime: 1,
      kind: 'attachment',
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    if (kind === 'pull-delete') expect(await placer.drop(base)).toBe(false)
    else if (kind === 'pull-source' || kind === 'pull-eviction')
      expect(
        await placer.place(
          change,
          base.sha,
          kind === 'pull-source' ? base : null,
          new Map(),
          new Map()
        )
      ).toBe(false)
    else if (kind === 'push-source') {
      await expect(
        state.transaction(async (tx) => {
          await new PushDisk(fs, tx, opts as unknown as ResumeOptions, sha256, new Map()).place(
            base,
            'b.md'
          )
        })
      ).rejects.toMatchObject({ code: 'conflict' })
    } else {
      const scope = { kind: 'group' as const, id: 'a', path: 'a.md' }
      const client = new V2EngineClient(
        encodeAccessToken({ v: 1, address: 'https://example.test', key: 'k'.repeat(43), scope }),
        {
          fetch: async (url) =>
            new URL(String(url)).pathname === '/v2/connection'
              ? Response.json({
                  protocol: 2,
                  token_id: 'token',
                  space_id: 'space',
                  scope,
                  status: 'active',
                  limits: { max_file_bytes: 10000, quota_bytes: null },
                })
              : Response.json({
                  items: [
                    {
                      type: 'removal',
                      file_id: 'a',
                      path: 'a.md',
                      cursor: 2,
                      at: '2026-01-01T00:00:00.000Z',
                    },
                  ],
                  next: null,
                  cursor: 2,
                }),
        }
      )
      await client.prepare(fs, state, () => false, undefined, true)
      const page = await client.changes(1)
      await captureDepartures(state, page.departures, fs)
      await dispatchDepartures(state, client)
      expect(await state.getCursor()).toBe(1)
    }
    expect(injected).toBe(true)
    await recoverRemovals(fs, state, { now: () => Date.now() + 8 * 86400000 })
    expect(await state.get(base.path)).toEqual(replacement)
    expect(await fs.read(base.path)).toEqual(bytes)
  }
)
