import { expect, it, vi } from 'vitest'
import {
  SyncClient,
  MemoryStateStore,
  MemoryFileSystem,
  ExpectedWrites,
  encodeText,
  pull,
} from '../../src/index.js'
import { PersonalNoteEvents } from '../../src/personalNoteEvents.js'
import { fetchFor } from '../helpers/serverFetch.js'
import { scopedFixture } from '@abele/sync-server/tests/helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '@abele/sync-server/tests/helpers/ops.js'
import { prepareFolderAdmissions } from '@abele/sync-server/src/scoped/admissions.js'
import { uploadScopedBlob } from '@abele/sync-server/src/scoped/uploads.js'
import { commitScoped } from '@abele/sync-server/src/scoped/commits.js'
async function fixture() {
  const f = await scopedFixture('sqlite')
  await putBlob(f.t.app, f.device.deviceToken, 'base')
  const note = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/n.md', 'base')])
  ).results[0]
  await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
  const client = new SyncClient({
      baseUrl: f.deps.endpointIdentity,
      token: f.device.deviceToken,
      fetch: fetchFor(f.t.app),
    }).forVault(f.vault),
    state = new MemoryStateStore(),
    fs = new MemoryFileSystem(),
    opts = {
      expected: new ExpectedWrites(),
      dirty: new Set<string>(),
      filter: { excluded: () => false },
    }
  await pull(client, fs, state, opts)
  const inbox = await PersonalNoteEvents.open(client, state, fs)
  return { ...f, note, client, state, fs, opts, inbox }
}
it('keeps shared edits enabled through the owner personal connection and exact delayed cache acknowledgement, never a path timer', async () => {
  const f = await fixture()
  try {
    await uploadScopedBlob(
      f.deps,
      f.a.key_token,
      f.vault,
      f.grant.id,
      shaOf('shared edit'),
      Buffer.from('shared edit')
    )
    const changed = (
      await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'shared', [
        {
          op: 'modify',
          file_id: f.note.file_id,
          base_version_id: f.note.version_id,
          sha: shaOf('shared edit'),
          size: 11,
          mtime: 2,
        },
      ])
    ).results[0]!
    const feed = await f.client.changes(0, 100)
    expect(feed.items.find((item) => item.version_id === changed.version_id)).toMatchObject({
      file_id: f.note.file_id,
      actor: { kind: 'key', id: f.a.key_id },
    })
    const seen: any[] = []
    const onPersonalNoteApplied = async (event: any, bytes: Uint8Array) => {
      seen.push(event)
      await f.inbox.record(event, bytes)
    }
    await pull(f.client, f.fs, f.state, { ...f.opts, onPersonalNoteApplied })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      fileId: f.note.file_id,
      versionId: changed.version_id,
      automatic: 'enabled',
      source: 'personal',
    })
    const reopened = await PersonalNoteEvents.open(f.client, f.state, f.fs),
      run = vi.fn(async () => {})
    const cache = {
      fileId: f.note.file_id,
      versionId: changed.version_id,
      path: 'Agents/n.md',
      sha: shaOf('shared edit'),
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600000)
    expect(await reopened.deliver({ ...cache, fileId: 'wrong-id' }, run)).toBe(false)
    expect(await reopened.deliver({ ...cache, versionId: f.note.version_id }, run)).toBe(false)
    expect(await reopened.deliver(cache, run)).toBe(true)
    expect(await reopened.deliver(cache, run)).toBe(false)
    expect(run).toHaveBeenCalledTimes(1)
    expect(await f.fs.read('Agents/n.md')).toEqual(encodeText('shared edit'))
  } finally {
    vi.restoreAllMocks()
    await f.close()
  }
})
it('binds delayed events to exact moved versions and personal credentials, never script staging or byte equality alone', async () => {
  const f = await fixture()
  try {
    const hook = async (event: any, bytes: Uint8Array) => f.inbox.record(event, bytes)
    await uploadScopedBlob(
      f.deps,
      f.a.key_token,
      f.vault,
      f.grant.id,
      shaOf('shared edit'),
      Buffer.from('shared edit')
    )
    const changed = (
      await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'shared', [
        {
          op: 'modify',
          file_id: f.note.file_id,
          base_version_id: f.note.version_id,
          sha: shaOf('shared edit'),
          size: 11,
          mtime: 2,
        },
      ])
    ).results[0]!
    await pull(f.client, f.fs, f.state, { ...f.opts, onPersonalNoteApplied: hook })
    const moved = (
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'move',
          file_id: f.note.file_id,
          base_version_id: changed.version_id,
          to_path: 'Agents/renamed.md',
        },
      ])
    ).results[0]
    await pull(f.client, f.fs, f.state, { ...f.opts, onPersonalNoteApplied: hook })
    const run = vi.fn(async () => {}),
      cache = {
        fileId: f.note.file_id,
        versionId: moved.version_id,
        path: 'Agents/renamed.md',
        sha: shaOf('shared edit'),
      }
    expect(
      await f.inbox.deliver({ ...cache, versionId: changed.version_id, path: 'Agents/n.md' }, run)
    ).toBe(false)
    expect(await f.inbox.deliver(cache, run)).toBe(true)
    const scoped = new SyncClient({
      baseUrl: f.deps.endpointIdentity,
      token: f.a.key_token,
      fetch: fetchFor(f.t.app),
    }).forVault(f.vault)
    await expect(PersonalNoteEvents.open(scoped, f.state, f.fs)).rejects.toMatchObject({
      code: 'unauthorized',
    })
    const other = await f.t.device(f.owner.accountToken, f.vault, 'other')
    await expect(
      PersonalNoteEvents.open(
        new SyncClient({
          baseUrl: f.deps.endpointIdentity,
          token: other.deviceToken,
          fetch: fetchFor(f.t.app),
        }).forVault(f.vault),
        f.state,
        f.fs
      )
    ).rejects.toMatchObject({ code: 'lost' })
    await putBlob(f.t.app, f.device.deviceToken, 'script bytes')
    const script = (
      await commit(f.t.app, f.device.deviceToken, f.vault, [create('Scripts/x.js', 'script bytes')])
    ).results[0]
    const staged = vi.fn(async () => {})
    await pull(f.client, f.fs, f.state, {
      ...f.opts,
      onPersonalNoteApplied: hook,
      defer: (path) => path.endsWith('.js'),
      onDefer: staged,
    })
    expect(staged).toHaveBeenCalled()
    expect(await f.fs.stat('Scripts/x.js')).toBeNull()
    expect(
      await f.inbox.deliver(
        {
          fileId: script.file_id,
          versionId: script.version_id,
          path: 'Scripts/x.js',
          sha: shaOf('script bytes'),
        },
        run
      )
    ).toBe(false)
  } finally {
    await f.close()
  }
})
it('holds stale cache/local bytes and retries the same enabled delivery after dispatcher failure and pull callback recovery', async () => {
  const f = await fixture()
  try {
    await uploadScopedBlob(
      f.deps,
      f.a.key_token,
      f.vault,
      f.grant.id,
      shaOf('shared edit'),
      Buffer.from('shared edit')
    )
    const changed = (
      await commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, 'shared', [
        {
          op: 'modify',
          file_id: f.note.file_id,
          base_version_id: f.note.version_id,
          sha: shaOf('shared edit'),
          size: 11,
          mtime: 2,
        },
      ])
    ).results[0]!
    let crash = true
    const onPersonalNoteApplied = async (event: any, bytes: Uint8Array) => {
      await f.inbox.record(event, bytes)
      if (crash) {
        crash = false
        throw new Error('cache inbox crash')
      }
    }
    await expect(
      pull(f.client, f.fs, f.state, { ...f.opts, onPersonalNoteApplied })
    ).rejects.toThrow('cache inbox crash')
    await pull(f.client, f.fs, f.state, { ...f.opts, onPersonalNoteApplied })
    const cache = {
        fileId: f.note.file_id,
        versionId: changed.version_id,
        path: 'Agents/n.md',
        sha: shaOf('shared edit'),
      },
      run = vi.fn(async () => {})
    await f.fs.writeAtomic(cache.path, encodeText('local changed'), 3)
    expect(await f.inbox.deliver(cache, run)).toBe(false)
    expect(run).not.toHaveBeenCalled()
    await f.fs.writeAtomic(cache.path, encodeText('shared edit'), 2)
    run.mockRejectedValueOnce(new Error('automation failure'))
    await expect(f.inbox.deliver(cache, run)).rejects.toThrow('automation failure')
    expect(await f.inbox.deliver(cache, run)).toBe(true)
    expect(run.mock.calls[0]).toEqual(run.mock.calls[1])
  } finally {
    await f.close()
  }
})
