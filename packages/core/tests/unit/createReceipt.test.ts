import { expect, it } from 'vitest'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { scan } from '../../src/scanner.js'
import { push } from '../../src/pusher.js'
import { ExpectedWrites } from '../../src/echo.js'
import type { EngineClient } from '../../src/engineClient.js'

it('D-020 retains the accepted create identity and pushes late typing as a modification after restart', async () => {
  const fs = new MemoryFileSystem(),
    state = new MemoryStateStore()
  await fs.writeAtomic('note.md', new TextEncoder().encode('before'), 1)
  const found = await scan(fs, state, { excluded: () => false })
  const op = found.ops[0]!
  if (op.op !== 'create') throw new Error('expected create')
  const client = {
    hasBlob: async () => true,
    commitRaw: async () => {
      await fs.writeAtomic('note.md', new TextEncoder().encode('typing'), 1)
      return {
        replayed: false,
        body: {
          head_seq: 1,
          results: [
            {
              status: 'applied',
              file_id: 'file',
              version_id: 'version',
              seq: 1,
              path: op.path,
              sha: op.sha,
              size: op.size,
              mtime: op.mtime,
            },
          ],
        },
      }
    },
  } as unknown as EngineClient
  const result = await push(client, fs, state, found, { expected: new ExpectedWrites() })
  expect(result.kept).toEqual(['note.md'])
  expect(await fs.read('note.md')).toEqual(new TextEncoder().encode('typing'))
  expect(await state.get('note.md')).toMatchObject({
    fileId: 'file',
    versionId: 'version',
    sha: op.sha,
  })
  const next = await scan(fs, state, { excluded: () => false })
  expect(next.ops).toEqual([
    expect.objectContaining({ op: 'modify', file_id: 'file', base_version_id: 'version' }),
  ])
  expect(await state.getJournal()).toBeNull()
})
