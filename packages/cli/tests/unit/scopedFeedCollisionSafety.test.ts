import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { ScopedState, createScopedClient, pullScoped } from '@abele/sync-core'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { scopedFixture } from '@abele/sync-server/tests/helpers/scopedFixture.js'
import { commit, create, putBlob } from '@abele/sync-server/tests/helpers/ops.js'
import {
  prepareFolderAdmissions,
  folderVersionInTransaction,
} from '@abele/sync-server/src/scoped/admissions.js'
import { withScopedAuthority } from '@abele/sync-server/src/scoped/authority.js'
import { readScopedState } from '@abele/sync-server/src/scoped/state.js'
import {
  openFolderSnapshot,
  readFolderSnapshotPage,
} from '@abele/sync-server/src/scoped/snapshots.js'
import { pollFolderFeed } from '@abele/sync-server/src/scoped/feed.js'
import { readFolderHistoricalVersion } from '@abele/sync-server/src/scoped/history.js'
it('holds a genuine content-feed collision against retained detached bytes after SQLite reopen', async () => {
  const scratch = resolve(process.cwd(), 'data')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, 'sample-feed-collision-')),
    f = await scopedFixture('sqlite'),
    file = join(dir, 'ledger.db')
  let raw = SqliteStateStore.open(file)
  try {
    await putBlob(f.t.app, f.device.deviceToken, 'BBB')
    await putBlob(f.t.app, f.device.deviceToken, 'AAA')
    const [b, a] = (
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        create('Agents/b.md', 'BBB'),
        create('Agents/z.md', 'AAA'),
      ])
    ).results
    await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
    const bound = await createScopedClient({
        baseUrl: f.deps.endpointIdentity,
        token: f.a.key_token,
        fetch: vi.fn(),
        vaultId: f.vault,
        grantId: f.grant.id,
        principalId: f.a.key_id,
        principalKind: 'key',
      }),
      fs = new NodeFileSystem(dir)
    const client = {
      binding: bound.binding,
      negotiate: async () => ({
        state: await readScopedState(f.deps, f.a.key_token, f.vault, f.grant.id),
      }),
      openSnapshot: vi.fn(() => openFolderSnapshot(f.deps, f.a.key_token, f.vault, f.grant.id)),
      snapshotPage: (_id: string, cursor: string) =>
        readFolderSnapshotPage(f.deps, f.a.key_token, f.vault, f.grant.id, cursor),
      feed: vi.fn((checkpoint: any) =>
        pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, checkpoint)
      ),
      head: vi.fn((id: string) =>
        withScopedAuthority(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          'read',
          async (tx, authority) => {
            const item = await tx
              .selectFrom('scope_current_members')
              .select(['file_id', 'version_id', 'path', 'kind', 'sha', 'size', 'mtime'])
              .where('grant_id', '=', f.grant.id)
              .where('file_id', '=', id)
              .executeTakeFirstOrThrow()
            await folderVersionInTransaction(tx, authority, id, item.version_id, f.deps.now(), {})
            if (item.sha === null) throw new Error('sample content missing')
            return { ...item, sha: item.sha }
          }
        )
      ),
      version: async (id: string, version: string) =>
        new Uint8Array(
          (
            await readFolderHistoricalVersion(
              f.deps,
              f.a.key_token,
              f.vault,
              f.grant.id,
              id,
              version,
              { method: 'GET' }
            )
          ).body!
        ),
    }
    let state = await ScopedState.open(raw, bound.binding, { initialize: true })
    expect((await pullScoped({ client, state, fs })).complete).toBe(true)
    await commit(f.t.app, f.device.deviceToken, f.vault, [
      { op: 'move', file_id: b!.file_id, base_version_id: b!.version_id, to_path: 'Private/b.md' },
    ])
    await pullScoped({ client, state, fs })
    expect((await state.getKnown(b!.file_id))?.state).toBe('detached')
    const checkpoint = await state.getCheckpoint(),
      placementB = await state.placementStore().byFileId(b!.file_id),
      placementA = await state.placementStore().byFileId(a!.file_id)
    expect(checkpoint).not.toBeNull()
    raw.close()
    raw = SqliteStateStore.open(file)
    state = await ScopedState.open(raw, bound.binding)
    expect(await state.getCheckpoint()).toEqual(checkpoint)
    const snapshots = client.openSnapshot.mock.calls.length
    client.feed.mockClear()
    client.head.mockClear()
    await commit(f.t.app, f.device.deviceToken, f.vault, [
      { op: 'move', file_id: a!.file_id, base_version_id: a!.version_id, to_path: 'Agents/b.md' },
    ])
    const report = await pullScoped({ client, state, fs })
    expect(client.openSnapshot.mock.calls.length).toBe(snapshots)
    expect(client.feed).toHaveBeenCalledWith(checkpoint)
    expect(client.head).toHaveBeenCalledWith(a!.file_id)
    expect(readFileSync(join(dir, 'Agents/b.md'), 'utf8')).toBe('BBB')
    expect(report.held).toContain(a!.file_id)
    expect(await state.getCheckpoint()).toEqual(checkpoint)
    expect(readFileSync(join(dir, 'Agents/z.md'), 'utf8')).toBe('AAA')
    expect(await state.placementStore().byFileId(b!.file_id)).toEqual(placementB)
    expect(await state.placementStore().byFileId(a!.file_id)).toEqual(placementA)
  } finally {
    raw.close()
    await f.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
