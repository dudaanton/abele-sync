import { expect, it } from 'vitest'
import {
  MemoryFileSystem,
  MemoryStateStore,
  ScopedState,
  createScopedClient,
  scanScopedChanges,
  encodeText,
} from '@abele/sync-core'
it('scans genuine folder-native images while never converting detached or unmaterialized bytes into creates', async () => {
  const client = await createScopedClient({
    baseUrl: 'https://issuer.example.test',
    token: `absk_${'a'.repeat(43)}`,
    fetch: async () => new Response(),
    vaultId: 'vault',
    grantId: 'grant',
    principalId: 'key',
    principalKind: 'key',
  })
  const state = await ScopedState.open(new MemoryStateStore(), client.binding, {
      initialize: true,
    }),
    fs = new MemoryFileSystem()
  await fs.writeAtomic('Agents/new.png', encodeText('image'), 1)
  await fs.writeAtomic('Attachments/private.png', encodeText('image'), 1)
  await fs.writeAtomic('Agents/unsafe.js', encodeText('unsafe'), 1)
  expect(
    (await scanScopedChanges(fs, state, 'Agents/')).map((op) => ('path' in op ? op.path : ''))
  ).toEqual(['Agents/new.png'])
  const op = (await scanScopedChanges(fs, state, 'Agents/'))[0]!
  if (op.op !== 'create') throw new Error('expected native creation')
  await state.putKnown({
    file_id: 'detached',
    version_id: 'version',
    path: 'Agents/new.png',
    sha: op.sha,
    size: op.size,
    mtime: 1,
    state: 'detached',
    dirty: true,
  })
  expect(await scanScopedChanges(fs, state, 'Agents/')).toEqual([])
})
