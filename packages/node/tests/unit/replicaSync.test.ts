import { mkdtemp, rm, readFile, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import {
  openNodeReplica,
  buildNodeEngine,
  CodeGroupDisk,
  CodeDraft,
  type NodeReplica,
} from '../../src/index.js'

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  uptime: () => 1000,
}))

it('retains foreign-ledger approval evidence in review without blocking a fresh stateDir', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'abele-ledger-owner-'))
  const server = await v2Server()
  let replica: NodeReplica | undefined
  try {
    const root = await createUser(
      { db: server.db, pepper: server.config.tokenPepper },
      'Example',
      server.address
    )
    const options = {
      dir: join(rootDir, 'files'),
      stateDir: join(rootDir, 'ledger-a'),
      key: root.token,
    }
    replica = await openNodeReplica(options)
    const group = await CodeGroupDisk.create(replica, () => true)
    const draft = await CodeDraft.create(replica.disk, group.work)
    await draft.preload(['example.txt'])
    await draft.writeAtomic('example.txt', new TextEncoder().encode('approved'), 1000)
    await replica.state.transaction((tx) => group.place(draft, tx))
    const journal = await readFile(join(group.work, 'journal.json'))
    replica.close()
    replica = undefined
    const other = await openNodeReplica({ ...options, stateDir: join(rootDir, 'ledger-b') })
    const reviews = CodeGroupDisk.reviews(other)
    other.close()
    expect(reviews).toHaveLength(1)
    const review = join(options.dir, reviews[0]!.path)
    expect(await readFile(join(options.dir, 'example.txt'), 'utf8')).toBe('approved')
    expect(await readFile(join(review, 'journal.json'))).toEqual(journal)
    expect(await readdir(review)).toContain('blobs')
    replica = await openNodeReplica(options)
    expect(await readFile(join(options.dir, 'example.txt'), 'utf8')).toBe('approved')
    expect(CodeGroupDisk.reviews(replica)).toHaveLength(1)
    expect(await readFile(join(review, 'journal.json'))).toEqual(journal)
    await expect(readFile(join(group.work, 'journal.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  } finally {
    replica?.close()
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})

it('resumes an external ledger without downloading already installed bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-state-resume-'))
  const server = await v2Server()
  const replicas: NodeReplica[] = []
  const engines: ReturnType<NodeReplica['buildEngine']>[] = []
  try {
    const root = await createUser(
      { db: server.db, pepper: server.config.tokenPepper },
      'Example',
      server.address
    )
    const source = await openNodeReplica({ dir: join(dir, 'source'), key: root.token })
    replicas.push(source)
    const a = source.buildEngine({ fallbackMs: 300_000, log() {} })
    engines.push(a)
    await source.fs.writeAtomic('example.txt', new TextEncoder().encode('hello'), 1000)
    await a.sync()
    const options = { dir: join(dir, 'target'), stateDir: join(dir, 'state'), key: root.token }
    const target = await openNodeReplica(options)
    replicas.push(target)
    const installed: string[] = []
    const applied = vi.fn(async (change: import('@abele/sync-core').AppliedChange) => {
      installed.push(await readFile(join(target.dir, change.path), 'utf8'))
    })
    const synced = vi.fn()
    const b = target.buildEngine({
      fallbackMs: 300_000,
      log() {},
      onApplied: applied,
      onSync: synced,
    })
    engines.push(b)
    await b.sync()
    expect(await readFile(join(target.dir, 'example.txt'), 'utf8')).toBe('hello')
    expect(applied).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: 'example.txt',
        kind: 'upsert',
        origin: 'remote',
        fileId: expect.any(String),
      })
    )
    expect(installed).toEqual(['hello'])
    await b.sync()
    expect(applied).toHaveBeenCalledTimes(1)
    expect(synced).toHaveBeenCalled()
    const cursor = await target.state.getCursor()
    await b.stop()
    target.close()
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (String(input).includes('/content')) throw new Error('unexpected download')
      return globalThis.fetch(input, init)
    })
    const reopened = await openNodeReplica({ ...options, fetch })
    replicas[1] = reopened
    expect(await reopened.state.getCursor()).toBe(cursor)
    const c = reopened.buildEngine({ fallbackMs: 300_000, log() {} })
    engines.push(c)
    await c.sync()
    expect(fetch.mock.calls.some(([input]) => String(input).includes('/content'))).toBe(false)
    expect(await readFile(join(target.dir, 'example.txt'), 'utf8')).toBe('hello')
  } finally {
    for (const engine of engines) await engine.stop()
    for (const replica of replicas) replica.close()
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'syncs and recovers an accepted publication (external state: %s)',
  async (external) => {
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
      const stateDir = external ? join(dir, 'first-state') : undefined
      const first = await openNodeReplica({ dir: join(dir, 'first'), stateDir, key: root.token })
      const second = await openNodeReplica({
        dir: join(dir, 'second'),
        key: root.token,
        defer: (path) => path === 'example.txt',
      })
      replicas.push(first, second)
      const a = first.buildEngine({ fallbackMs: 300_000, log() {} })
      // CLI code approvals replace fs with a draft using this same composition pattern.
      const applied = vi.fn()
      const b = buildNodeEngine(
        { ...second, fs: second.fs },
        { fallbackMs: 300_000, log() {}, onApplied: applied }
      )
      engines.push(a, b)
      await first.fs.writeAtomic('example.txt', new TextEncoder().encode('hello'), 1000)
      await a.sync()
      await b.sync()
      expect((await b.deferred()).map((item) => item.path)).toEqual(['example.txt'])
      expect(applied).not.toHaveBeenCalled()
      await expect(readFile(join(second.dir, 'example.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await b.applyDeferred()
      expect(await readFile(join(second.dir, 'example.txt'), 'utf8')).toBe('hello')
      expect(applied).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          path: 'example.txt',
          kind: 'upsert',
          origin: 'remote',
        })
      )
      const file = (await first.client.manifest(null)).items.find(
        (item) => item.path === 'example.txt'
      )!
      const ops = [
        { op: 'delete' as const, file_id: file.file_id, base_version_id: file.version_id },
      ]
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
      const reopened = await openNodeReplica({ dir: first.dir, stateDir, key: root.token })
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
  }
)
