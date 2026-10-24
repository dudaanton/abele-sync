import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createUser } from '../../src/access/tokens.js'
import { v2Server, type V2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { V2IssueTokenResponseSchema } from '@abele/sync-protocol'

for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`unified v2 sync (${dialect})`, () => {
    let server: V2Server | undefined
    afterEach(async () => {
      await server?.close()
      server = undefined
    })
    async function setup() {
      server = await v2Server(dialect)
      const root = await createUser(
        { db: server.db, pepper: server.config.tokenPepper, dialect },
        'Owner',
        server.address
      )
      const owner = new V2SyncClient(root.token)
      const mkdir = await owner.commit([
        { op: 'mkdir', path: 'Shared' },
        { op: 'mkdir', path: 'Other' },
      ])
      expect(mkdir.results.every((r) => r.status === 'applied')).toBe(true)
      const share = await owner.share(
        mkdir.results[0]!.status === 'rejected' ? '' : mkdir.results[0]!.file_id
      )
      return {
        owner,
        guest: new V2SyncClient(share.token),
        root,
        share,
        directory: mkdir.results[0]!,
      }
    }
    it('D-011 stores host-specific file and directory names unchanged on the wire', async () => {
      const { owner } = await setup()
      const names = [
        'a:b',
        'a*b',
        'a?b',
        'a"b',
        'a<b',
        'a>b',
        'a|b',
        'tail.',
        'tail ',
        'CON',
        'prn.txt',
      ]
      for (const name of names) {
        expect((await owner.create(`Shared/${name}`, 'bytes')).status).toBe('applied')
        expect(
          (await owner.commit([{ op: 'mkdir', path: `Other/${name}` }])).results[0]?.status
        ).toBe('applied')
      }
      const manifest = await owner.manifest()
      for (const name of names) {
        expect(manifest.items.some((item) => item.path === `Shared/${name}`)).toBe(true)
        expect(
          manifest.items.some((item) => item.path === `Other/${name}` && item.kind === 'directory')
        ).toBe(true)
      }
      const paths = (await server!.db.selectFrom('files').select('path').execute()).map(
        (row) => row.path
      )
      for (const name of names) expect(paths).toContain(`Shared/${name}`)
    })
    it('005/006/035/036/037/042/043/053/069 root and folder use one API, preserve paths and empty directories, folder contains all bytes', async () => {
      const { owner, guest } = await setup()
      await owner.commit([{ op: 'mkdir', path: 'Shared/Empty/Child' }])
      const note = await guest.create('Shared/Note.md', '[[Other]]\n')
      const binary = await owner.create('Shared/Image.png', Buffer.from([0, 1, 255]))
      await owner.create('Other/Private.md', 'secret')
      const snapshot = await guest.manifest()
      expect(snapshot.items.map((i) => i.path).sort()).toEqual([
        'Shared',
        'Shared/Empty',
        'Shared/Empty/Child',
        'Shared/Image.png',
        'Shared/Note.md',
      ])
      expect((await owner.manifest()).items.map((i) => i.path)).toContain('Other/Private.md')
      const beforeRetry = (await owner.manifest()).cursor
      expect((await owner.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!.status).toBe(
        'applied'
      )
      expect((await owner.manifest()).cursor).toBe(beforeRetry)
      if (note.status === 'rejected' || binary.status === 'rejected')
        throw new Error('create refused')
      expect((await guest.content(note.file_id)).toString()).toBe('[[Other]]\n')
      expect(await guest.content(binary.file_id)).toEqual(Buffer.from([0, 1, 255]))
      expect((await guest.create('Other/Bad.md', 'denied')).status).toBe('rejected')
    })
    it('038/040 identical create is a no-op; case and file/directory obstacles reject without loss', async () => {
      const { owner, guest } = await setup()
      const first = await guest.create('Shared/Note.md', 'same')
      const head = (await owner.manifest()).cursor
      expect(await guest.create('Shared/Note.md', 'same')).toEqual(first)
      expect((await owner.manifest()).cursor).toBe(head)
      expect((await guest.create('Shared/note.md', 'same')).status).toBe('rejected')
      for (const path of ['Shared', 'Shared/Empty']) {
        if (path.endsWith('Empty')) await owner.commit([{ op: 'mkdir', path }])
        expect((await guest.create(path, 'file obstacle')).status).toBe('rejected')
      }
      const renamed = await guest.commit([{ op: 'mkdir', path: 'shared/Case' }])
      expect(renamed.results[0]!.status).toBe('rejected')
      expect((await guest.manifest()).items.find((i) => i.path === 'Shared/Note.md')).toBeDefined()
    })
    it('044/045/046/047/048/049/051 scoped departure is removal, actual deletion is delete; private destination and history stay private', async () => {
      const { owner, guest } = await setup()
      let file = await owner.create('Other/Private.md', 'private past')
      if (file.status === 'rejected') throw new Error('create refused')
      const privateVersion = file.version_id
      file = (
        await owner.commit([
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'Shared/Note.md',
          },
        ])
      ).results[0]!
      if (file.status === 'rejected') throw new Error('move refused')
      expect((await guest.content(file.file_id)).toString()).toBe('private past')
      await expect(guest.content(file.file_id, privateVersion)).rejects.toMatchObject({
        status: 404,
      })
      const start = (await guest.manifest()).cursor
      const moved = (
        await owner.commit([
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'Other/SecretDestination.md',
          },
        ])
      ).results[0]!
      const departure = await guest.changes(start)
      expect(departure.items).toEqual([
        expect.objectContaining({ type: 'removal', path: 'Shared/Note.md' }),
      ])
      expect(JSON.stringify(departure)).not.toContain('SecretDestination')
      await expect(guest.content(file.file_id)).rejects.toMatchObject({ status: 404 })
      expect(
        (
          await guest.commit([
            { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
          ])
        ).results[0]!.status
      ).toBe('rejected')
      if (moved.status === 'rejected') throw new Error('move refused')
      file = (
        await owner.commit([
          {
            op: 'move',
            file_id: moved.file_id,
            base_version_id: moved.version_id,
            to_path: 'Shared/Returned.md',
          },
        ])
      ).results[0]!
      if (file.status === 'rejected') throw new Error('return refused')
      const changed = await guest.upload(Buffer.from('---\ncustom: retained\n---\nchanged\n'))
      file = (
        await guest.commit([
          {
            op: 'modify',
            file_id: file.file_id,
            base_version_id: file.version_id,
            ...changed,
            mtime: 2000,
          },
        ])
      ).results[0]!
      if (file.status === 'rejected') throw new Error('modify refused')
      expect((await owner.content(file.file_id)).toString()).toContain('custom: retained')
      const beforeDelete = (await guest.manifest()).cursor
      await guest.commit([
        { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
      ])
      expect((await guest.changes(beforeDelete)).items).toEqual([
        expect.objectContaining({ type: 'delete', path: 'Shared/Returned.md' }),
      ])
    })
    it('032/054/055/056 stable shared folder follows owner rename, moves descendants atomically, deleting affects no sibling', async () => {
      const { owner, guest, directory, share } = await setup()
      if (directory.status === 'rejected') throw new Error('mkdir refused')
      await guest.create('Shared/Sub/Note.md', 'kept')
      await owner.create('Other/Neighbor.md', 'neighbor')
      const nested = (await guest.manifest()).items.find((i) => i.path === 'Shared/Sub')!
      const delegated = new V2SyncClient((await guest.share(nested.file_id)).token)
      let result = (
        await owner.commit([
          {
            op: 'move_directory',
            file_id: directory.file_id,
            base_version_id: directory.version_id,
            to_path: 'Renamed',
          },
        ])
      ).results[0]!
      expect(result.status).toBe('applied')
      expect((await guest.json('/connection')).scope).toEqual({
        kind: 'folder',
        id: share.info.scope.id,
        path: 'Renamed',
      })
      expect((await guest.manifest()).items.map((i) => i.path).sort()).toEqual([
        'Renamed',
        'Renamed/Sub',
        'Renamed/Sub/Note.md',
      ])
      expect((await delegated.manifest()).items.map((i) => i.path)).toContain('Renamed/Sub/Note.md')
      const currentSub = (await owner.manifest()).items.find((i) => i.file_id === nested.file_id)!
      await owner.commit([
        {
          op: 'move_directory',
          file_id: currentSub.file_id,
          base_version_id: currentSub.version_id,
          to_path: 'Other/Escaped',
        },
      ])
      expect((await guest.changes(0)).items).toContainEqual(
        expect.objectContaining({ type: 'removal', path: 'Renamed/Sub/Note.md' })
      )
      expect((await delegated.json('/connection')).status).toBe('scope_unavailable')
      await expect(delegated.manifest()).rejects.toMatchObject({ status: 503 })
      if (result.status === 'rejected') throw new Error('rename refused')
      await owner.commit([
        { op: 'delete_directory', file_id: result.file_id, base_version_id: result.version_id },
      ])
      expect((await guest.json('/connection')).status).toBe('scope_unavailable')
      expect((await owner.manifest()).items.map((i) => i.path)).toContain('Other/Neighbor.md')
    })
    it('054 explicit case-only folder rename keeps identity and sharing', async () => {
      const { owner, guest, directory } = await setup()
      if (directory.status === 'rejected') throw new Error(directory.message)
      const file = await guest.create('Shared/Sub/Note.md', 'case-safe')
      if (file.status === 'rejected') throw new Error(file.message)
      const result = (
        await owner.commit([
          {
            op: 'move_directory',
            file_id: directory.file_id,
            base_version_id: directory.version_id,
            to_path: 'shared',
          },
        ])
      ).results[0]!
      expect(result.status).toBe('applied')
      expect((await guest.json('/connection')).scope.path).toBe('shared')
      expect((await guest.manifest()).items.find((i) => i.file_id === file.file_id)!.path).toBe(
        'shared/Sub/Note.md'
      )
      expect((await guest.content(file.file_id)).toString()).toBe('case-safe')
    })
    it('070/071/072/073 any participant can modify/move/delete opaque files regardless of author', async () => {
      const { owner, guest } = await setup()
      let file = await owner.create('Shared/Canvas.canvas', '{"nodes":[]}')
      if (file.status === 'rejected') throw new Error('create refused')
      file = (
        await guest.commit([
          {
            op: 'modify',
            file_id: file.file_id,
            base_version_id: file.version_id,
            ...(await guest.upload(Buffer.from('{"nodes":[1]}'))),
            mtime: 2000,
          },
        ])
      ).results[0]!
      if (file.status === 'rejected') throw new Error('modify refused')
      expect((await owner.content(file.file_id)).toString()).toBe('{"nodes":[1]}')
      file = (
        await guest.commit([
          {
            op: 'move',
            file_id: file.file_id,
            base_version_id: file.version_id,
            to_path: 'Shared/Sub/New.canvas',
          },
        ])
      ).results[0]!
      if (file.status === 'rejected') throw new Error('move refused')
      await guest.commit([
        { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
      ])
      expect((await owner.manifest()).items.find((i) => i.file_id === file.file_id)).toBeUndefined()
    })
    it('039 first accepted original and one divergent conflict copy', async () => {
      const { owner, guest } = await setup()
      await owner.create('Shared/Note.md', 'server original\n')
      await guest.create('Shared/Note.md', 'local divergent\n')
      const files = (await guest.manifest()).items.filter((i) => i.kind !== 'directory')
      expect(files).toHaveLength(2)
      expect(
        (await guest.content(files.find((i) => i.path === 'Shared/Note.md')!.file_id)).toString()
      ).toBe('server original\n')
      expect(
        (await guest.content(files.find((i) => i.path !== 'Shared/Note.md')!.file_id)).toString()
      ).toBe('local divergent\n')
    })
    it('108/110 stale line edits merge with the latest original mtime', async () => {
      const { owner, guest } = await setup()
      const base = await owner.create('Shared/Note.md', 'one\ntwo\n', 1000)
      if (base.status === 'rejected') throw new Error(base.message)
      const head = await owner.upload(Buffer.from('ONE\ntwo\n'))
      await owner.commit([
        {
          op: 'modify',
          file_id: base.file_id,
          base_version_id: base.version_id,
          ...head,
          mtime: 2000,
        },
      ])
      const incoming = await guest.upload(Buffer.from('one\nTWO\n'))
      await guest.commit([
        {
          op: 'modify',
          file_id: base.file_id,
          base_version_id: base.version_id,
          ...incoming,
          mtime: 3000,
        },
      ])
      expect((await guest.content(base.file_id)).toString()).toBe('ONE\nTWO\n')
      expect((await guest.manifest()).items.find((i) => i.file_id === base.file_id)!.mtime).toBe(
        3000
      )
    })
    it('authorized snapshots page at a fixed cursor and feed continues durably after restart', async () => {
      const { owner, guest } = await setup()
      await guest.create('Shared/A.md', 'a')
      await guest.create('Shared/B.md', 'b')
      const first = await guest.manifest('?limit=1')
      expect(first.next).not.toBeNull()
      await owner.create('Shared/C.md', 'c')
      await server!.restart()
      let page = first,
        paths = first.items.map((i) => i.path)
      while (page.next) {
        page = await guest.manifest('?next=' + encodeURIComponent(page.next))
        expect(page.cursor).toBe(first.cursor)
        paths.push(...page.items.map((i) => i.path))
      }
      expect(paths.sort()).toEqual(['Shared', 'Shared/A.md', 'Shared/B.md'])
      expect(
        (await guest.changes(first.cursor, '&limit=1')).items.some((i) => i.path === 'Shared/C.md')
      ).toBe(true)
      await expect(
        owner.manifest('?next=' + encodeURIComponent(first.next!))
      ).rejects.toMatchObject({ status: 400 })
    })
    it('a commit consumes only its own token upload proof, not another folder token waiting on the same SHA', async () => {
      const { owner, guest } = await setup()
      const directory = (await owner.manifest()).items.find((i) => i.path === 'Other')!
      const other = new V2SyncClient((await owner.share(directory.file_id)).token)
      const body = Buffer.from('same bytes, separate scopes')
      const blob = await guest.upload(body)
      await other.upload(body)
      const first = (
        await guest.commit([{ op: 'create', path: 'Shared/First.md', ...blob, mtime: 1000 }])
      ).results[0]!
      expect(first.status).toBe('applied')
      expect(
        await server!.db
          .selectFrom('blob_uploads')
          .select('device_id')
          .where('sha', '=', blob.sha)
          .execute()
      ).toHaveLength(1)
      const second = (
        await other.commit([{ op: 'create', path: 'Other/Second.md', ...blob, mtime: 1000 }])
      ).results[0]!
      expect(second.status).toBe('applied')
      if (second.status !== 'rejected') expect(await other.content(second.file_id)).toEqual(body)
    })
    it('a visibility write failure rolls back the entire engine/directory batch and sequence', async () => {
      const { owner, guest } = await setup()
      const before = await owner.manifest()
      const blob = await guest.upload(Buffer.from('not partially committed'))
      if (dialect === 'sqlite')
        await sql
          .raw(
            "create trigger reject_scope_event before insert on scope_changes when new.event like '%Fail.md%' begin select raise(abort, 'synthetic visibility fault'); end"
          )
          .execute(server!.db)
      else
        await sql`alter table scope_changes add constraint reject_scope_event check (event not like '%Fail.md%')`.execute(
          server!.db
        )
      await expect(
        guest.commit([
          { op: 'mkdir', path: 'Shared/SafeDirectory' },
          { op: 'create', path: 'Shared/Fail.md', ...blob, mtime: 1000 },
        ])
      ).rejects.toMatchObject({ status: 500 })
      const after = await owner.manifest()
      expect(after.cursor).toBe(before.cursor)
      expect(after.items).toEqual(before.items)
      expect(await server!.db.selectFrom('versions').selectAll().execute()).toEqual([])
      expect((await guest.changes(before.cursor)).items).toEqual([])
    })
    it('token+scope authorization precedes cached commits; private SHA/base/version/upload IDs confer no access', async () => {
      const { owner, guest, share } = await setup()
      const privateFile = await owner.create('Other/Secret.md', 'secret')
      if (privateFile.status === 'rejected') throw new Error('create refused')
      const guessed = await guest.commit([
        {
          op: 'create',
          path: 'Shared/Guessed.md',
          sha: privateFile.sha!,
          size: privateFile.size,
          mtime: 1000,
        },
      ])
      expect(guessed.results[0]!.status).toBe('rejected')
      const data = await guest.upload(Buffer.from('safe'))
      const ops = [{ op: 'create' as const, path: 'Shared/Safe.md', ...data, mtime: 1000 }]
      expect(await guest.commit(ops, 'retry-key')).toEqual(await guest.commit(ops, 'retry-key'))
      await expect(
        guest.commit([{ ...ops[0]!, path: 'Shared/Changed.md' }], 'retry-key')
      ).rejects.toMatchObject({ status: 422, code: 'idempotency_mismatch' })
      await owner.json('/tokens/' + share.info.id, 'DELETE')
      await expect(guest.commit(ops, 'retry-key')).rejects.toMatchObject({ status: 401 })
      await expect(guest.content(privateFile.file_id)).rejects.toMatchObject({ status: 401 })
    })
  })
}
