import { describe, expect, it, vi } from 'vitest'
import { pushScoped } from '../../src/scopedPush.js'
import { createScopedClient, ScopedState } from '../../src/scopedConnection.js'
import { MemoryFileSystem } from '../../src/fs.js'
import { MemoryStateStore } from '../../src/state.js'
import { encodeText } from '../../src/hash.js'
import { scopedFixture } from '@abele/sync-server/tests/helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '@abele/sync-server/tests/helpers/ops.js'
import { prepareFolderAdmissions } from '@abele/sync-server/src/scoped/admissions.js'
import { commitScoped } from '@abele/sync-server/src/scoped/commits.js'
import { uploadScopedBlob } from '@abele/sync-server/src/scoped/uploads.js'
import { readFolderHistoricalVersion } from '@abele/sync-server/src/scoped/history.js'
async function fixture() {
  const f = await scopedFixture('sqlite'),
    base = 'a\nb\nc\n'
  await putBlob(f.t.app, f.device.deviceToken, base)
  const first = (
    await commit(f.t.app, f.device.deviceToken, f.vault, [create('Agents/note.md', base)])
  ).results[0]
  await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
  const bound = await createScopedClient({
    baseUrl: f.deps.endpointIdentity,
    token: f.a.key_token,
    fetch: vi.fn() as unknown as typeof fetch,
    vaultId: f.vault,
    grantId: f.grant.id,
    principalId: f.a.key_id,
    principalKind: 'key',
  })
  const raw = new MemoryStateStore(),
    state = await ScopedState.open(raw, bound.binding, { initialize: true }),
    fs = new MemoryFileSystem()
  await fs.writeAtomic('Agents/note.md', encodeText(base), 1)
  await state.placementStore().put({
    path: 'Agents/note.md',
    wirePath: 'Agents/note.md',
    fileId: first.file_id,
    versionId: first.version_id,
    sha: shaOf(base),
    size: base.length,
    mtime: 1,
  })
  await state.putKnown({
    file_id: first.file_id,
    version_id: first.version_id,
    path: 'Agents/note.md',
    sha: shaOf(base),
    size: base.length,
    mtime: 1,
    state: 'materialized',
    dirty: false,
  })
  const client = {
    binding: bound.binding,
    negotiate: async () => ({
      state: { state: 'active', role: 'editor', selector: { kind: 'folder', prefix: 'Agents/' } },
    }),
    putBlob: vi.fn((sha: string, bytes: Uint8Array) =>
      uploadScopedBlob(f.deps, f.a.key_token, f.vault, f.grant.id, sha, bytes)
    ),
    commit: vi.fn((request: any) =>
      commitScoped(f.deps, f.a.key_token, f.vault, f.grant.id, request.request_id, request.ops)
    ),
    version: async (file: string, version: string) =>
      new Uint8Array(
        (
          await readFolderHistoricalVersion(
            f.deps,
            f.a.key_token,
            f.vault,
            f.grant.id,
            file,
            version,
            { method: 'GET' }
          )
        ).body!
      ),
  }
  return { ...f, first, raw, state, fs, client }
}
describe('scoped push recovery', () => {
  for (const failure of ['known', 'hook'] as const)
    it(`recovers completed placement but unfinished ${failure} settlement before retiring the journal`, async () => {
      const f = await fixture()
      try {
        await f.fs.writeAtomic('Agents/new.png', encodeText('image'), 3)
        const ops = [
          { op: 'create' as const, path: 'Agents/new.png', sha: shaOf('image'), size: 5, mtime: 3 },
        ]
        const hook = vi.fn(async () => {})
        if (failure === 'known')
          vi.spyOn(f.state, 'putKnown').mockRejectedValueOnce(new Error('settlement fault'))
        else hook.mockRejectedValueOnce(new Error('settlement fault'))
        await expect(pushScoped({ ...f, ops, onSettled: hook })).rejects.toThrow('settlement fault')
        const journal = (await f.state.getJournal())!
        const placed = await f.state.getEntry('Agents/new.png')
        expect(placed).not.toBeNull()
        await pushScoped({ ...f, onSettled: hook })
        expect((await f.state.getKnown(placed!.fileId))?.native).toBe(true)
        expect(hook).toHaveBeenCalledTimes(failure === 'known' ? 1 : 2)
        expect(f.client.commit.mock.calls.at(-1)?.[0].request_id).toBe(journal.request_id)
        expect(await f.state.getJournal()).toBeNull()
      } finally {
        await f.close()
      }
    })
  it('does not treat dirty local bytes as submitted content for a move-only operation', async () => {
    const f = await fixture()
    try {
      await f.fs.writeAtomic('Agents/note.md', encodeText('unsent'), 4)
      const result = await pushScoped({
        ...f,
        ops: [
          {
            op: 'move',
            file_id: f.first.file_id,
            base_version_id: f.first.version_id,
            to_path: 'Agents/moved.md',
          },
        ],
      })
      expect(result.held).toContain(f.first.file_id)
      expect(await f.fs.read('Agents/note.md')).toEqual(encodeText('unsent'))
      expect(f.client.putBlob).not.toHaveBeenCalled()
      const versions = await f.t.db
        .selectFrom('versions')
        .select('blob_sha')
        .where('file_id', '=', f.first.file_id)
        .execute()
      expect(versions.map((row) => row.blob_sha)).not.toContain(shaOf('unsent'))
    } finally {
      await f.close()
    }
  })
  it('re-proves expired staged bytes under the original request ID without uploading a later local save', async () => {
    const f = await fixture()
    try {
      await f.fs.writeAtomic('Agents/note.md', encodeText('submitted'), 3)
      const ops = [
        {
          op: 'modify' as const,
          file_id: f.first.file_id,
          base_version_id: f.first.version_id,
          sha: shaOf('submitted'),
          size: 9,
          mtime: 3,
        },
      ]
      f.client.commit.mockRejectedValueOnce(new Error('stopped before send'))
      await expect(pushScoped({ ...f, ops })).rejects.toThrow('stopped before send')
      const journal = (await f.state.getJournal())!
      expect(journal.phase).toBe('staged')
      await f.t.db
        .updateTable('scope_blob_uploads')
        .set({ expires_at: '2029-01-01T00:00:00.000Z' })
        .execute()
      await f.fs.writeAtomic('Agents/note.md', encodeText('later'), 4)
      const recovered = await pushScoped(f)
      expect(recovered.committed).toBe(true)
      expect(f.client.putBlob.mock.calls.map((call) => call[0])).toEqual([
        shaOf('submitted'),
        shaOf('submitted'),
      ])
      expect(
        f.client.commit.mock.calls.every((call) => call[0].request_id === journal.request_id)
      ).toBe(true)
      expect(await f.fs.read('Agents/note.md')).toEqual(encodeText('later'))
      expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(2)
    } finally {
      await f.close()
    }
  })
  it('merges offline edits in place using personal semantics and recovers a lost committed reply under the original request identity', async () => {
    const f = await fixture()
    try {
      const owner = 'A\nb\nc\n',
        incoming = 'a\nb\nC\n'
      await putBlob(f.t.app, f.device.deviceToken, owner)
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: f.first.file_id,
          base_version_id: f.first.version_id,
          sha: shaOf(owner),
          size: owner.length,
          mtime: 2,
        },
      ])
      await f.fs.writeAtomic('Agents/note.md', encodeText(incoming), 3)
      const ops = [
        {
          op: 'modify' as const,
          file_id: f.first.file_id,
          base_version_id: f.first.version_id,
          sha: shaOf(incoming),
          size: incoming.length,
          mtime: 3,
        },
      ]
      const send = f.client.commit.getMockImplementation()!
      f.client.commit.mockImplementationOnce(async (request) => {
        await send(request)
        throw new Error('lost reply')
      })
      await expect(pushScoped({ ...f, ops })).rejects.toThrow('lost reply')
      const request = (await f.state.getJournal())!.request_id
      const result = await pushScoped(f)
      expect(result.committed).toBe(true)
      expect(f.client.commit.mock.calls[1]?.[0].request_id).toBe(request)
      expect(await f.fs.read('Agents/note.md')).toEqual(encodeText('A\nb\nC\n'))
      expect(await f.state.getJournal()).toBeNull()
      expect(await f.t.db.selectFrom('versions').select('id').execute()).toHaveLength(4)
    } finally {
      await f.close()
    }
  })
  it('settles an explicit authorized restore without a new upload and refuses private restore lineage', async () => {
    const f = await fixture()
    try {
      await putBlob(f.t.app, f.device.deviceToken, 'owner edit')
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: f.first.file_id,
          base_version_id: f.first.version_id,
          sha: shaOf('owner edit'),
          size: 10,
          mtime: 2,
        },
      ])
      const restored = await pushScoped({
        ...f,
        ops: [{ op: 'restore', file_id: f.first.file_id, version_id: f.first.version_id }],
      })
      expect(restored.committed).toBe(true)
      expect(f.client.putBlob).not.toHaveBeenCalled()
      expect(await f.fs.read('Agents/note.md')).toEqual(encodeText('a\nb\nc\n'))
      await putBlob(f.t.app, f.device.deviceToken, 'private')
      const hidden = (
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Private/hidden.md', 'private'),
        ])
      ).results[0]
      await expect(
        pushScoped({
          ...f,
          ops: [{ op: 'restore', file_id: f.first.file_id, version_id: hidden.version_id }],
        })
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(await f.fs.read('Agents/note.md')).toEqual(encodeText('a\nb\nc\n'))
    } finally {
      await f.close()
    }
  })
  it('preserves a save made during settlement and keeps detached work out of a new upload', async () => {
    const f = await fixture()
    try {
      const incoming = 'a\nb\nC\n',
        owner = 'A\nb\nc\n'
      await putBlob(f.t.app, f.device.deviceToken, owner)
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: f.first.file_id,
          base_version_id: f.first.version_id,
          sha: shaOf(owner),
          size: owner.length,
          mtime: 2,
        },
      ])
      await f.fs.writeAtomic('Agents/note.md', encodeText(incoming), 3)
      const version = f.client.version
      f.client.version = async (...args) => {
        await f.fs.writeAtomic('Agents/note.md', encodeText('later save'), 4)
        return version(...args)
      }
      const result = await pushScoped({
        ...f,
        ops: [
          {
            op: 'modify',
            file_id: f.first.file_id,
            base_version_id: f.first.version_id,
            sha: shaOf(incoming),
            size: incoming.length,
            mtime: 3,
          },
        ],
      })
      expect(result.held).toContain(f.first.file_id)
      expect(await f.fs.read('Agents/note.md')).toEqual(encodeText('later save'))
      await f.state.putKnown({
        ...(await f.state.getKnown(f.first.file_id)),
        state: 'detached',
        dirty: true,
      })
      await f.state.setJournal(null)
      await expect(
        pushScoped({
          ...f,
          ops: [
            {
              op: 'modify',
              file_id: f.first.file_id,
              base_version_id: f.first.version_id,
              sha: shaOf('later save'),
              size: 10,
              mtime: 4,
            },
          ],
        })
      ).rejects.toMatchObject({ code: 'conflict' })
    } finally {
      await f.close()
    }
  })
})
