import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  ScopedState,
  createScopedClient,
  pullScoped,
  pushScoped,
  MemoryStateStore,
} from '@abele/sync-core'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { scopedFixture } from '@abele/sync-server/tests/helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '@abele/sync-server/tests/helpers/ops.js'
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
import { uploadScopedBlob } from '@abele/sync-server/src/scoped/uploads.js'
import { commitScoped } from '@abele/sync-server/src/scoped/commits.js'
for (const adapter of ['sqlite', 'memory', 'memory-legacy'] as const)
  it(`preserves detached placement and bytes through real push, ${adapter} reopen and subsequent pull`, async () => {
    const scratch = resolve(process.cwd(), 'data')
    mkdirSync(scratch, { recursive: true })
    const dir = mkdtempSync(join(scratch, 'sample-scoped-settlement-')),
      f = await scopedFixture('sqlite'),
      file = join(dir, 'state.db')
    let raw: SqliteStateStore | MemoryStateStore =
      adapter === 'sqlite' ? SqliteStateStore.open(file) : new MemoryStateStore()
    try {
      await putBlob(f.t.app, f.device.deviceToken, 'BBB')
      await putBlob(f.t.app, f.device.deviceToken, 'AAA')
      const seed = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/b.md', 'BBB'),
            create('Agents/z.md', 'AAA'),
          ])
        ).results,
        [b, a] = seed
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
        feed: vi.fn((checkpoint: any, limit?: number) =>
          pollFolderFeed(f.deps, f.a.key_token, f.vault, f.grant.id, checkpoint, limit)
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
              if (item.sha === null) throw new Error('sample head missing content')
              return { ...item, sha: item.sha }
            }
          )
        ),
        putBlob: (sha: string, bytes: Uint8Array) =>
          uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, Buffer.from(bytes)),
        commit: (request: any) =>
          commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, request.request_id, request.ops),
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
      await pullScoped({ client, state, fs })
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'move',
          file_id: b!.file_id,
          base_version_id: b!.version_id,
          to_path: 'Private/b.md',
        },
      ])
      await pullScoped({ client, state, fs })
      const placementB = await state.placementStore().byFileId(b!.file_id),
        placementA = await state.placementStore().byFileId(a!.file_id)
      expect((await state.getKnown(b!.file_id))?.state).toBe('detached')
      const report = await pushScoped({
        client,
        state,
        fs,
        ops: [
          {
            op: 'move',
            file_id: a!.file_id,
            base_version_id: a!.version_id,
            to_path: 'Agents/b.md',
          },
        ],
      })
      expect(report.held).toContain(a!.file_id)
      expect(readFileSync(join(dir, 'Agents/b.md'), 'utf8')).toBe('BBB')
      if (adapter === 'sqlite')
        expect(await state.placementStore().byFileId(b!.file_id)).toEqual(placementB)
      const legacy =
        adapter === 'memory-legacy' ? { ...placementA!, wirePath: 'Agents/b.md' } : null
      if (legacy) await state.placementStore().put(legacy)
      if (raw instanceof SqliteStateStore) {
        raw.close()
        raw = SqliteStateStore.open(file)
      }
      state = await ScopedState.open(raw, bound.binding)
      const head = await f.t.db
        .selectFrom('files')
        .select('head_version_id')
        .where('id', '=', a!.file_id)
        .executeTakeFirstOrThrow()
      await putBlob(f.t.app, f.device.deviceToken, 'DDD')
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: a!.file_id,
          base_version_id: head.head_version_id!,
          sha: shaOf('DDD'),
          size: 3,
          mtime: 2,
        },
      ])
      const pulled = await pullScoped({ client, state, fs })
      expect(readFileSync(join(dir, 'Agents/b.md'), 'utf8')).toBe('BBB')
      expect(pulled.held).toContain(a!.file_id)
      expect(readFileSync(join(dir, 'Agents/z.md'), 'utf8')).toBe('AAA')
      expect(await state.placementStore().byFileId(b!.file_id)).toEqual(placementB)
      expect(await state.placementStore().byFileId(a!.file_id)).toEqual(legacy ?? placementA)
      // finishPush resets progress, and a held snapshot cannot advance it.
      // The feed is unreachable here; verify that invariant without inventing a cursor.
      expect(await state.getCheckpoint()).toBeNull()
      const snapshots = client.openSnapshot.mock.calls.length,
        feeds = client.feed.mock.calls.length
      client.head.mockClear()
      const next = await f.t.db
        .selectFrom('files')
        .select('head_version_id')
        .where('id', '=', a!.file_id)
        .executeTakeFirstOrThrow()
      await putBlob(f.t.app, f.device.deviceToken, 'EEE')
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: a!.file_id,
          base_version_id: next.head_version_id!,
          sha: shaOf('EEE'),
          size: 3,
          mtime: 3,
        },
      ])
      const heldSnapshot = await pullScoped({ client, state, fs })
      expect(client.openSnapshot.mock.calls.length).toBe(snapshots + 1)
      expect(client.feed.mock.calls.length).toBe(feeds)
      expect(client.head).not.toHaveBeenCalled()
      expect(heldSnapshot.held).toContain(a!.file_id)
      expect(await state.getCheckpoint()).toBeNull()
      expect(readFileSync(join(dir, 'Agents/b.md'), 'utf8')).toBe('BBB')
      expect(readFileSync(join(dir, 'Agents/z.md'), 'utf8')).toBe('AAA')
      expect(await state.placementStore().byFileId(b!.file_id)).toEqual(placementB)
      expect(await state.placementStore().byFileId(a!.file_id)).toEqual(legacy ?? placementA)
    } finally {
      if (raw instanceof SqliteStateStore) raw.close()
      await f.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
