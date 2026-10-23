import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ownsBlob } from '@abele/sync-server/src/access/blobAuthority.js'
import { authenticateToken, createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server, type V2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { V2EngineClient } from '../../src/v2Client.js'
import { sha256 } from '../../src/hash.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { DurableStateStore } from '../sim/durableState.js'
import { SimScheduler } from '../sim/scheduler.js'
import { scan } from '../../src/scanner.js'
import { push, resumeJournal } from '../../src/pusher.js'
import { ExpectedWrites } from '../../src/echo.js'
let server: V2Server | undefined
afterEach(async () => {
  await server?.close()
})
it.each(['commit', 'complete', 'part', 'simple'] as const)(
  'D-199 recovery sends no accepted bytes after lost %s response',
  async (cut) => {
    server = await v2Server()
    const root = await createUser(
      { db: server.db, pepper: server.config.tokenPepper },
      'Owner',
      server.address
    )
    const bytes = new Uint8Array(cut === 'simple' ? 1024 : 9 * 1024 * 1024 + 17).fill(71)
    const sha = await sha256(bytes)
    let sent = 0,
      armed = true
    const controller = new AbortController()
    const transport: typeof fetch = async (url, init) => {
      if (init?.method === 'PUT') sent += (init.body as Uint8Array).byteLength
      const response = await fetch(url, init)
      const path = new URL(String(url)).pathname
      if (
        armed &&
        response.ok &&
        (cut === 'commit'
          ? path === '/v2/commit'
          : cut === 'complete'
            ? path.endsWith('/complete')
            : cut === 'simple'
              ? init?.method === 'PUT'
              : /\/0$/.test(path))
      ) {
        armed = false
        await response.arrayBuffer()
        controller.abort(new Error('process crashed after server acceptance'))
        throw controller.signal.reason
      }
      return response
    }
    const make = () => new V2EngineClient(root.token, { fetch: transport })
    let client = make()
    const fs = new MemoryFileSystem(),
      scheduler = new SimScheduler(199)
    let state = new DurableStateStore(scheduler)
    await fs.writeAtomic('large.bin', bytes, 1)
    const found = await scan(fs, state, { excluded: () => false })
    await expect(
      push(client, fs, state, found, { expected: new ExpectedWrites(), signal: controller.signal })
    ).rejects.toThrow()
    expect(armed).toBe(false)
    expect(await state.get('large.bin')).toBeNull()
    const before = sent
    scheduler.crash()
    state = state.reopen()
    client = make() // discard all client caches after the crash
    if (await state.getJournal())
      await resumeJournal(client, fs, state, { expected: new ExpectedWrites() })
    else
      await push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
        expected: new ExpectedWrites(),
      })
    expect(sent - before).toBe(cut === 'part' ? bytes.length - before : 0)
    expect((await state.get('large.bin'))?.sha).toBe(sha)
    // A fresh source and a fresh buffered upload must both dedupe too.
    const accepted = sent
    await client.putBlobSource(
      { sha, size: bytes.length },
      {
        size: bytes.length,
        read: async (at, length) => bytes.slice(at, at + length),
        assertUnchanged: async () => {},
        close: async () => {},
      }
    )
    await client.putBlob(sha, bytes)
    expect(sent).toBe(accepted)
  }
)

it('D-199 a lost accepted part acknowledgement is queried before an in-process retry', async () => {
  server = await v2Server()
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper },
    'Owner',
    server.address
  )
  const bytes = new Uint8Array(1024 * 1024 + 7).fill(53),
    sha = await sha256(bytes)
  let sent = 0,
    lost = false,
    closed = false
  const client = new V2EngineClient(root.token, {
    fetch: async (url, init) => {
      if (init?.method === 'PUT') sent += (init.body as Uint8Array).byteLength
      const response = await fetch(url, init)
      if (!lost && response.ok && /\/0$/.test(String(url))) {
        lost = true
        await response.arrayBuffer()
        throw new Error('accepted part response lost')
      }
      return response
    },
  })
  await client.putBlobSource(
    { sha, size: bytes.length },
    {
      size: bytes.length,
      read: async (at, length) => bytes.slice(at, at + length),
      assertUnchanged: async () => {},
      close: async () => {
        closed = true
      },
    }
  )
  expect(lost).toBe(true)
  expect(closed).toBe(true)
  expect(sent).toBe(bytes.length)
})

it('D-199 existence checks preserve token and current-scope byte authority', async () => {
  server = await v2Server()
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper },
    'Owner',
    server.address
  )
  const other = await createUser(
    { db: server.db, pepper: server.config.tokenPepper },
    'Other',
    server.address
  )
  const owner = new V2SyncClient(root.token)
  const dir = (await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!
  if (dir.status === 'rejected') throw new Error(dir.message)
  const share = await owner.share(dir.file_id)
  const original = new V2EngineClient(root.token, { fetch })
  const guest = new V2EngineClient(share.token, { fetch })
  const foreign = new V2EngineClient(other.token, { fetch })
  const bytes = new Uint8Array([1, 2, 3]),
    sha = await sha256(bytes)
  await original.putBlob(sha, bytes)
  expect(await original.hasBlob(sha)).toBe(true)
  const probe = vi.spyOn(server.store, 'has')
  expect(await guest.hasBlob(sha)).toBe(false)
  expect(await foreign.hasBlob(sha)).toBe(false)
  expect(probe).not.toHaveBeenCalled()
  probe.mockRestore()
  const committed = (
    await owner.commit([{ op: 'create', path: 'Shared/a.bin', sha, size: 3, mtime: 1 }])
  ).results[0]!
  if (committed.status === 'rejected') throw new Error(committed.message)
  expect(await guest.hasBlob(sha)).toBe(true)
  await owner.commit([
    {
      op: 'move',
      file_id: committed.file_id,
      base_version_id: committed.version_id,
      to_path: 'Private.bin',
    },
  ])
  expect(await guest.hasBlob(sha)).toBe(false)
  expect(await original.hasBlob(sha)).toBe(true)
  await owner.json('/tokens/' + share.info.id, 'DELETE')
  await expect(guest.hasBlob(sha)).rejects.toMatchObject({ code: 'unauthorized' })
  // Direct buffered callers still cannot pass bytes that disagree with their SHA.
  await expect(original.putBlob(sha, new Uint8Array([9]))).rejects.toMatchObject({
    code: 'hash_mismatch',
  })
})

it('D-199 absent SHA probes use the vault/digest index rather than scanning scope history', async () => {
  server = await v2Server()
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper },
    'Owner',
    server.address
  )
  const principal = await authenticateToken(
    { db: server.db, pepper: server.config.tokenPepper },
    new V2SyncClient(root.token).key
  )
  const spy = vi.spyOn(server.db.getExecutor(), 'executeQuery')
  await ownsBlob(server.db, principal, '0'.repeat(64))
  const query = spy.mock.calls.find(([q]) => q.sql.includes('scope_versions'))![0]
  spy.mockRestore()
  const plan = await server.db.executeQuery({ ...query, sql: 'EXPLAIN QUERY PLAN ' + query.sql })
  expect(plan.rows.map((row) => (row as { detail: string }).detail).join('\n')).toContain(
    'versions_vault_sha'
  )
})
