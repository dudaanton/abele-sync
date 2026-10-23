import { expect, it, vi } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { ExpectedWrites, MemoryFileSystem, MemoryStateStore, pull } from '../../src/index.js'
import type { EngineClient } from '../../src/engineClient.js'

it.each(['identity', 'version', 'case', 'unicode'])(
  'retains a held remote delete after %s ownership changes at the absence observation',
  async (mode) => {
    const state = new MemoryStateStore()
    const fs = new MemoryFileSystem({ caseInsensitive: true })
    const base = {
      path: 'Café.md',
      wirePath: 'Café.md',
      fileId: 'file',
      versionId: 'v1',
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
    }
    await state.put(base)
    await state.setCursor(1)
    const replacement = {
      ...base,
      fileId: mode === 'version' ? base.fileId : 'replacement',
      versionId: 'new',
      path:
        mode === 'case'
          ? base.path.toLowerCase()
          : mode === 'unicode'
            ? base.path.normalize('NFD')
            : base.path,
      wirePath: mode === 'case' || mode === 'unicode' ? 'other.md' : base.wirePath,
    }
    const change: ChangeItem = {
      seq: 2,
      file_id: base.fileId,
      version_id: 'deleted',
      path: base.path,
      op: 'delete',
      prev_path: null,
      sha: null,
      size: null,
      mtime: null,
      kind: 'note',
      actor: { kind: 'system', id: 'test', name: 'test' },
      at: '',
    }
    const client = {
      changes: async () => ({ items: [change], head_seq: 2, next_since: 2 }),
    } as unknown as EngineClient
    const stat = fs.stat.bind(fs)
    let injected = false
    vi.spyOn(fs, 'stat').mockImplementation(async (path) => {
      const observed = await stat(path)
      if (!injected && path === base.path) {
        injected = true
        await state.put(replacement)
      }
      return observed
    })
    const report = await pull(client, fs, state, {
      dirty: new Set([base.wirePath]),
      noted: new Set([base.wirePath]),
      filter: { excluded: () => false },
      expected: new ExpectedWrites(),
    })
    expect(injected).toBe(true)
    expect(await state.get(replacement.path)).toEqual(replacement)
    expect(report.settled ?? []).not.toContain(base.fileId)
    // Reopen the pull owner from durable holds: a retry must not replace its
    // expected base with the newer observation and then retire that new base.
    const restarted = await pull(client, fs, state, {
      dirty: new Set([base.wirePath]),
      noted: new Set([base.wirePath]),
      filter: { excluded: () => false },
      expected: new ExpectedWrites(),
    })
    expect(await state.get(replacement.path)).toEqual(replacement)
    expect(restarted.settled ?? []).not.toContain(base.fileId)
  }
)
