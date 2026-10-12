import { describe, expect, it } from 'vitest'
import { tokenFixture, success } from '../helpers/tokenFixture.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

const grouped = (name: string, body = 'body') => `---\ngroups: ["[[${name}]]"]\n---\n${body}\n`
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`review access boundaries (${dialect})`, () => {
    async function chain() {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('G.md', 'root\n'))
        const i = success(await f.root.create('I.md', grouped('G')))
        const n = success(await f.root.create('N.md', grouped('I')))
        const token = await f.root.json('/tokens', 'POST', {
          scope: { kind: 'group', id: g.file_id },
          label: 'Group',
        })
        return { ...f, g, i, n, group: new V2SyncClient(token.token) }
      } catch (error) {
        await f.close()
        throw error
      }
    }
    it('review 1: a note retyped as an attachment is never a live group intermediate, even after deletion and descendant edits', async () => {
      const f = await chain()
      try {
        const before = (await f.group.manifest()).cursor
        const moved = success(
          (
            await f.root.commit([
              {
                op: 'move',
                file_id: f.i.file_id,
                base_version_id: f.i.version_id,
                to_path: 'I.png',
              },
            ])
          ).results[0]!
        )
        expect((await f.group.manifest()).items.map((i) => i.file_id)).not.toContain(f.n.file_id)
        expect((await f.group.changes(before)).items).toContainEqual(
          expect.objectContaining({ type: 'removal', file_id: f.n.file_id })
        )
        expect(
          await f.t.db
            .selectFrom('group_notes')
            .selectAll()
            .where('file_id', '=', f.i.file_id)
            .execute()
        ).toEqual([])
        expect(
          await f.t.db
            .selectFrom('group_names')
            .selectAll()
            .where('file_id', '=', f.i.file_id)
            .execute()
        ).toEqual([])
        await f.root.commit([
          { op: 'delete', file_id: f.i.file_id, base_version_id: moved.version_id },
        ])
        success(
          (
            await f.root.commit([
              {
                op: 'modify',
                file_id: f.n.file_id,
                base_version_id: f.n.version_id,
                ...(await f.root.upload(Buffer.from(grouped('I', 'PRIVATE new bytes')))),
                mtime: 2000,
              },
            ])
          ).results[0]!
        )
        expect((await f.group.manifest()).items.map((i) => i.file_id)).not.toContain(f.n.file_id)
        await expect(f.group.content(f.n.file_id)).rejects.toMatchObject({ status: 404 })
      } finally {
        await f.close()
      }
    })
    it('review 2: only the deleted target may use archived edges; broken live intermediates deny trash/history/content/modify/restore', async () => {
      const f = await chain()
      try {
        await f.root.commit([
          { op: 'delete', file_id: f.n.file_id, base_version_id: f.n.version_id },
        ])
        expect((await f.group.json('/trash')).map((i: { file_id: string }) => i.file_id)).toContain(
          f.n.file_id
        )
        expect((await f.group.content(f.n.file_id, f.n.version_id)).toString()).toBe(grouped('I'))
        await f.root.commit([
          { op: 'delete', file_id: f.i.file_id, base_version_id: f.i.version_id },
        ])
        const replacement = success(await f.root.create('N.md', grouped('G', 'public replacement')))
        expect((await f.group.content(replacement.file_id)).toString()).toBe(
          grouped('G', 'public replacement')
        )
        // A public replacement at the same path cannot authorize the old identity.
        expect(
          (await f.group.json('/trash')).map((i: { file_id: string }) => i.file_id)
        ).not.toContain(f.n.file_id)
        await expect(f.group.json(`/files/${f.n.file_id}/history`)).rejects.toMatchObject({
          status: 404,
        })
        await expect(f.group.content(f.n.file_id, f.n.version_id)).rejects.toMatchObject({
          status: 404,
        })
        const versions = await f.t.db.selectFrom('versions').select('id').execute()
        expect(
          (
            await f.group.json(
              `/files/${f.n.file_id}/restore`,
              'POST',
              { deleted: true },
              { 'idempotency-key': 'broken-chain' }
            )
          ).status
        ).toBe('rejected')
        expect(
          (
            await f.group.commit([
              { op: 'restore', file_id: f.n.file_id, version_id: f.n.version_id },
            ])
          ).results[0]!.status
        ).toBe('rejected')
        expect(
          (
            await f.group.commit([
              {
                op: 'modify',
                file_id: f.n.file_id,
                base_version_id: f.n.version_id,
                ...(await f.group.upload(Buffer.from(grouped('I', 'cannot revive')))),
                mtime: 3000,
              },
            ])
          ).results[0]!.status
        ).toBe('rejected')
        expect(await f.t.db.selectFrom('versions').select('id').execute()).toEqual(versions)
        // Restoring the intermediate through legitimate root authority restores the chain.
        success(
          await f.root.json(
            `/files/${f.i.file_id}/restore`,
            'POST',
            { deleted: true },
            { 'idempotency-key': 'root-restore-i' }
          )
        )
        expect((await f.group.content(f.n.file_id, f.n.version_id)).toString()).toBe(grouped('I'))
        expect(
          (
            await f.group.json(
              `/files/${f.n.file_id}/restore`,
              'POST',
              { deleted: true },
              { 'idempotency-key': 'live-chain' }
            )
          ).status
        ).toBe('applied')
        expect((await f.group.manifest()).items.map((item) => item.file_id)).toContain(f.n.file_id)
      } finally {
        await f.close()
      }
    })
    for (const mode of ['restore', 'revive'] as const) {
      it(`review 4: ${mode} avoids an explicit directory occupying the original file path`, async () => {
        const f = await tokenFixture(dialect)
        try {
          const file = success(await f.root.create('Agents/restore.md', 'original\n'))
          await f.root.commit([
            { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
          ])
          success((await f.root.commit([{ op: 'mkdir', path: 'Agents/restore.md' }])).results[0]!)
          const result = success(
            mode === 'restore'
              ? await f.guest.json(
                  `/files/${file.file_id}/restore`,
                  'POST',
                  { deleted: true },
                  { 'idempotency-key': 'restore-obstacle' }
                )
              : (
                  await f.guest.commit([
                    {
                      op: 'modify',
                      file_id: file.file_id,
                      base_version_id: file.version_id,
                      ...(await f.guest.upload(Buffer.from('offline edit\n'))),
                      mtime: 2000,
                    },
                  ])
                ).results[0]!
          )
          expect(result.path).not.toBe('Agents/restore.md')
          expect((await f.guest.content(file.file_id)).toString()).toBe(
            mode === 'restore' ? 'original\n' : 'offline edit\n'
          )
          const items = (await f.guest.manifest()).items
          expect(items.filter((i) => i.path === 'Agents/restore.md').map((i) => i.kind)).toEqual([
            'directory',
          ])
          expect(new Set(items.map((i) => i.path)).size).toBe(items.length)
        } finally {
          await f.close()
        }
      })
      it(`review 4: ${mode} cannot generate a destination with a noncanonical directory ancestor`, async () => {
        const f = await tokenFixture(dialect)
        try {
          const file = success(await f.root.create('Agents/Sub/restore.md', 'original\n'))
          await f.root.commit([
            { op: 'delete', file_id: file.file_id, base_version_id: file.version_id },
          ])
          const dir = (await f.root.manifest()).items.find((i) => i.path === 'Agents/Sub')!
          success(
            (
              await f.root.commit([
                {
                  op: 'move_directory',
                  file_id: dir.file_id,
                  base_version_id: dir.version_id,
                  to_path: 'Agents/sub',
                },
              ])
            ).results[0]!
          )
          const result =
            mode === 'restore'
              ? await f.guest.json(
                  `/files/${file.file_id}/restore`,
                  'POST',
                  { deleted: true },
                  { 'idempotency-key': 'restore-parent-case' }
                )
              : (
                  await f.guest.commit([
                    {
                      op: 'modify',
                      file_id: file.file_id,
                      base_version_id: file.version_id,
                      ...(await f.guest.upload(Buffer.from('offline\n'))),
                      mtime: 2000,
                    },
                  ])
                ).results[0]!
          expect(result.status).toBe('rejected')
          expect((await f.root.manifest()).items.filter((i) => i.kind !== 'directory')).toEqual([])
        } finally {
          await f.close()
        }
      })
    }
    it('review 5: issuing a subgroup validates the entire inherited folder boundary before disclosing a path or initializing scope state', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('Agents/G.md', 'root\n'))
        const group = new V2SyncClient(
          (
            await f.guest.json('/tokens', 'POST', {
              scope: { kind: 'group', id: g.file_id },
              label: 'Confined',
            })
          ).token
        )
        const secret = success(await f.root.create('Private/Secret.md', grouped('Agents/G')))
        expect((await group.manifest()).items.map((i) => i.file_id)).not.toContain(secret.file_id)
        const tokens = await f.t.db.selectFrom('access_tokens').select('id').execute()
        const scopes = await f.t.db.selectFrom('access_scopes').select('id').execute()
        const response = await group.request('/tokens', 'POST', {
          scope: { kind: 'group', id: secret.file_id },
          label: 'Unknown selector',
        })
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain('Private/Secret.md')
        expect(await f.t.db.selectFrom('access_tokens').select('id').execute()).toEqual(tokens)
        expect(await f.t.db.selectFrom('access_scopes').select('id').execute()).toEqual(scopes)
      } finally {
        await f.close()
      }
    })
    it('review 5: listing directly issued tokens hides targets that escaped any inherited boundary', async () => {
      const f = await tokenFixture(dialect)
      try {
        const g = success(await f.root.create('Agents/G.md', 'root\n'))
        const group = new V2SyncClient(
          (
            await f.guest.json('/tokens', 'POST', {
              scope: { kind: 'group', id: g.file_id },
              label: 'Confined',
            })
          ).token
        )
        const note = success(await f.root.create('Agents/Note.md', grouped('Agents/G')))
        const issued = await group.json('/tokens', 'POST', {
          scope: { kind: 'group', id: note.file_id },
          label: 'Visible child',
        })
        await f.root.commit([
          {
            op: 'move',
            file_id: note.file_id,
            base_version_id: note.version_id,
            to_path: 'Private/ListSecret.md',
          },
        ])
        expect((await new V2SyncClient(issued.token).json('/connection')).status).toBe(
          'scope_unavailable'
        )
        const list = await group.json('/tokens')
        expect(JSON.stringify(list)).not.toContain('Private/ListSecret.md')
        expect(list.items.find((t: { id: string }) => t.id === issued.info.id).scope.path).toBe(
          '(unavailable)'
        )
        await group.json('/tokens/' + issued.info.id, 'DELETE')
      } finally {
        await f.close()
      }
    })
    it('review 6: a partial folder can atomically delete its selected nonempty tree, never create content after losing authority', async () => {
      const f = await tokenFixture(dialect)
      try {
        await f.root.create('Agents/Sub/a.md', 'shared\n')
        await f.root.create('Private.md', 'neighbor\n')
        const snapshot = await f.guest.manifest()
        const dir = snapshot.items.find((i) => i.path === 'Agents')!
        const blob = await f.guest.upload(Buffer.from('not recreated'))
        const result = await f.guest.commit([
          { op: 'delete_directory', file_id: dir.file_id, base_version_id: dir.version_id },
          { op: 'create', path: 'Agents/Recreated.md', ...blob, mtime: 2000 },
        ])
        expect(result.results.map((r) => r.status)).toEqual(['applied', 'rejected'])
        expect(
          (await f.guest.changes(snapshot.cursor)).items.map((i) => [i.type, i.path]).sort()
        ).toEqual([
          ['delete', 'Agents'],
          ['delete', 'Agents/Sub'],
          ['delete', 'Agents/Sub/a.md'],
        ])
        expect((await f.guest.json('/connection')).status).toBe('scope_unavailable')
        expect((await f.root.manifest()).items.map((i) => i.path)).toEqual(['Private.md'])
      } finally {
        await f.close()
      }
    })
  })
