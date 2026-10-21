import { expect, it } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { ExpectedWrites } from '../../src/echo.js'
import { scan } from '../../src/scanner.js'
import { push } from '../../src/pusher.js'
import { sha256 } from '../../src/hash.js'
import { reconciliationScan, readReconciliation } from '../../src/reconciliation.js'
import type { EngineClient } from '../../src/engineClient.js'

for (const evidence of ['ordinary', 'reappeared-source', 'generation-change'] as const)
  it(`D-013 distinguishes an interrupted authored move from ${evidence} evidence`, async () => {
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    const bytes = new Uint8Array([1]),
      sha = await sha256(bytes)
    await fs.writeAtomic('new.md', bytes, 1)
    await state.put({
      path: 'old.md',
      wirePath: 'old.md',
      fileId: 'file',
      versionId: 'old',
      sha,
      size: 1,
      mtime: 1,
    })
    await state.setCursor(1)
    await state.setMeta('server-restore-generation', 'stable')
    const found = await scan(fs, state, { excluded: () => false })
    expect(found.ops[0]).toMatchObject({ op: 'move' })
    const client = {
      commitRaw: async () => {
        throw new Error('commit answer lost')
      },
      versions: async () => [],
    } as unknown as EngineClient
    await expect(
      push(client, fs, state, found, { expected: new ExpectedWrites() })
    ).rejects.toThrow('commit answer lost')
    if (evidence === 'reappeared-source') await fs.writeAtomic('old.md', bytes, 1)
    if (evidence === 'generation-change') await state.setMeta('server-restore-generation', 'new')
    await reconciliationScan(
      fs,
      state,
      { excluded: () => false },
      2,
      undefined,
      undefined,
      true,
      client
    )
    const reconciliation = await readReconciliation(state)
    if (evidence === 'ordinary') {
      expect(reconciliation).toBeNull()
      expect(await state.getJournal()).not.toBeNull()
    } else expect(reconciliation?.phase).toBe('requested')
  })
