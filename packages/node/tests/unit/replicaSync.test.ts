import { mkdtemp, rm, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { openNodeReplica, buildNodeEngine, type NodeReplica } from '../../src/index.js'

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  uptime: () => 1000,
}))

it('syncs two Node replicas and recovers an accepted publication after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-node-sync-'))
  const server = await v2Server()
  const replicas: NodeReplica[] = []
  const engines: ReturnType<NodeReplica['buildEngine']>[] = []
  try {
    const root = await createUser(
      { db: server.db, pepper: server.config.tokenPepper },
      'Example',
      server.address
    )
    const first = await openNodeReplica({ dir: join(dir, 'first'), key: root.token })
    const second = await openNodeReplica({
      dir: join(dir, 'second'),
      key: root.token,
      defer: (path) => path === 'example.txt',
    })
    replicas.push(first, second)
    const a = first.buildEngine({ fallbackMs: 300_000, log() {} })
    // CLI code approvals replace fs with a draft using this same composition pattern.
    const b = buildNodeEngine({ ...second, fs: second.fs }, { fallbackMs: 300_000, log() {} })
    engines.push(a, b)
    await first.fs.writeAtomic('example.txt', new TextEncoder().encode('hello'), 1000)
    await a.sync()
    await b.sync()
    expect((await b.deferred()).map((item) => item.path)).toEqual(['example.txt'])
    await expect(readFile(join(second.dir, 'example.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await b.applyDeferred()
    expect(await readFile(join(second.dir, 'example.txt'), 'utf8')).toBe('hello')
    const file = (await first.client.manifest(null)).items.find(
      (item) => item.path === 'example.txt'
    )!
    const ops = [{ op: 'delete' as const, file_id: file.file_id, base_version_id: file.version_id }]
    await unlink(join(first.dir, 'example.txt'))
    await first.state.setJournal({
      batchId: 'interrupted',
      ops,
      idempotencyKey: 'interrupted',
      startedAt: new Date().toISOString(),
    })
    await first.client.commit(ops, 'interrupted')
    await a.stop()
    first.close()
    const reopened = await openNodeReplica({ dir: first.dir, key: root.token })
    replicas[0] = reopened
    expect(await reopened.state.getJournal()).toBeNull()
    expect((await reopened.client.manifest(null)).items).toHaveLength(0)
    await b.sync()
    await b.applyDeferred()
    await expect(readFile(join(second.dir, 'example.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    for (const engine of engines) await engine.stop()
    for (const replica of replicas) replica.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
