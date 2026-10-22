import { describe, expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'

describe.each(process.env.ABELE_TEST_PG_URL ? (['sqlite', 'pg'] as const) : (['sqlite'] as const))(
  'group engines (%s)',
  (dialect) => {
    it(
      '014/041/057–068 production group engines create nested members, preserve foreign groups, converge two servers, remove departures and preserve unavailable files',
      async () => {
        const f = await acceptanceFixture(dialect)
        try {
          const [a, b, c] = f.devices
          for (const device of f.devices)
            for (const id of [...device.connections.keys()]) await device.disconnect(id)
          const owners = f.roots.map((r) => new V2SyncClient(r.token))
          const groups: Array<{ file_id: string }> = []
          for (const [i, owner] of owners.entries()) {
            const root = await owner.create(
              'Groups/Root.md',
              `---\ngroups: ["[[Foreign-${i}]]"]\n---\nroot\n`
            )
            if (root.status === 'rejected') throw new Error(root.message)
            groups.push(root)
            const token = await owner.json('/tokens', 'POST', {
              scope: { kind: 'group', id: root.file_id },
              label: 'Group',
            })
            for (const device of f.devices) await device.paste(token.token, `group-${i}`)
          }
          const rounds = async (n = 5) => {
            for (let round = 0; round < n; round++)
              for (const d of f.devices) for (const id of d.connections.keys()) await d.sync(id)
          }
          await rounds()
          await a!.write('Groups/Child.md', '---\ngroups: ["[[Groups/Root]]"]\n---\nchild\n')
          await a!.write(
            'Notes/Member.md',
            '---\ngroups: ["[[Groups/Child]]", "[[Foreign]]"]\ncustom: kept\n---\nmember\n'
          )
          await a!.write('Notes/Private.md', 'private neighbor')
          await a!.write('Private.png', 'private bytes')
          await rounds(7)
          for (const d of f.devices)
            expect(await d.text('Notes/Member.md')).toContain('custom: kept')
          for (const owner of owners) {
            expect((await owner.manifest()).items.map((i) => i.path)).toContain('Notes/Member.md')
            expect((await owner.manifest()).items.map((i) => i.path)).not.toContain(
              'Notes/Private.md'
            )
            expect((await owner.manifest()).items.map((i) => i.path)).not.toContain('Private.png')
          }
          await b!.write(
            'Notes/Member.md',
            '---\ngroups: ["[[Groups/Child]]", "[[Foreign]]"]\ncustom: kept\n---\nchanged\n'
          )
          await rounds()
          for (const d of f.devices) expect(await d.text('Notes/Member.md')).toContain('changed')
          for (const [i, owner] of owners.entries()) {
            const head = (await owner.manifest()).items.find(
              (item) => item.file_id === groups[i]!.file_id
            )!
            await owner.commit([
              {
                op: 'move',
                file_id: head.file_id,
                base_version_id: head.version_id,
                to_path: 'Groups/Renamed.md',
              },
            ])
          }
          await rounds()
          await c!.restart()
          await c!.write(
            'Notes/AfterRename.md',
            '---\ngroups: ["[[Groups/Child]]"]\n---\nafter rename\n'
          )
          await rounds()
          for (const d of f.devices)
            expect(await d.text('Notes/AfterRename.md')).toContain('after rename')
          const count = async () =>
            Promise.all(f.servers.map((s) => s.db.selectFrom('versions').select('id').execute()))
          const before = await count()
          await rounds(3)
          expect(await count()).toEqual(before)
          await a!.write('Notes/Member.md', '---\ngroups: ["[[Foreign]]"]\n---\nleft\n')
          await rounds()
          expect(await b!.fs.stat('Notes/Member.md')).toBeNull()
          expect(await c!.fs.stat('Notes/Member.md')).toBeNull()
          expect(await a!.text('Notes/Member.md')).toContain('left')
          await a!.write(
            'Notes/Member.md',
            '---\ngroups: ["[[Groups/Child]]", "[[Foreign]]"]\n---\nreturned\n'
          )
          await rounds()
          for (const d of f.devices) expect(await d.text('Notes/Member.md')).toContain('returned')
          for (const [i, owner] of owners.entries()) {
            const head = (await owner.manifest()).items.find(
              (v) => v.file_id === groups[i]!.file_id
            )!
            await owner.commit([
              { op: 'delete', file_id: head.file_id, base_version_id: head.version_id },
            ])
          }
          for (const d of f.devices)
            for (const id of d.connections.keys()) {
              await expect(d.sync(id)).rejects.toMatchObject({ code: 'scope_unavailable' })
              expect(await d.text('Notes/Member.md')).toContain('returned')
            }
        } finally {
          await f.close()
        }
      },
      // This bounded six-connection workflow takes ~8.5 s alone on Linux/ext4;
      // allow parallel-runner contention and durable cleanup without a speed assertion.
      60 * 1_000
    )

    it(
      '066 local root rename is a move, not scope deletion, across two servers and restart; NFD local member paths remain eligible',
      async () => {
        const f = await acceptanceFixture(dialect)
        try {
          for (const d of f.devices)
            for (const id of [...d.connections.keys()]) await d.disconnect(id)
          const owners = f.roots.map((r) => new V2SyncClient(r.token))
          const roots: Array<{ file_id: string }> = []
          for (const [i, owner] of owners.entries()) {
            const root = await owner.create('Root.md', 'group root\n')
            if (root.status === 'rejected') throw new Error(root.message)
            roots.push(root)
            const token = await owner.json('/tokens', 'POST', {
              scope: { kind: 'group', id: root.file_id },
              label: 'Group',
            })
            for (const d of f.devices) await d.paste(token.token, `group-${i}`)
          }
          const mutations = () =>
            f.devices.reduce(
              (n, d) =>
                n +
                d.network.requests.filter(
                  (r) =>
                    r.method === 'PUT' ||
                    (r.method === 'POST' && new URL(r.url).pathname.endsWith('/commit'))
                ).length,
              0
            )
          let totalSyncs = 0
          const rounds = async (n = 5, requireIdle = true) => {
            let syncs = 0
            for (let round = 0; round < n; round++) {
              const before = mutations()
              for (const d of f.devices)
                for (const id of d.connections.keys()) {
                  await d.sync(id)
                  syncs++
                  totalSyncs++
                }
              if (requireIdle && mutations() === before) {
                expect(syncs, 'bounded convergence work').toBeLessThanOrEqual(
                  4 * f.devices.reduce((n, d) => n + d.connections.size, 0)
                )
                return
              }
            }
            if (requireIdle)
              throw new Error(`group rename did not reach a quiet round within ${n} passes`)
          }
          await rounds()
          const a = f.devices[0]!
          await a.write(
            'Café.md'.normalize('NFD'),
            '---\ngroups: ["[[Root]]"]\n---\nunicode member\n'
          )
          await rounds()
          for (const d of f.devices) expect(await d.text('Café.md')).toContain('unicode member')
          await a.move('Root.md', 'Renamed.md')
          await rounds()
          for (const [i, owner] of owners.entries())
            expect(
              (await owner.manifest()).items.find((item) => item.file_id === roots[i]!.file_id)
                ?.path
            ).toBe('Renamed.md')
          for (const d of f.devices) {
            expect(await d.text('Renamed.md')).toBe('group root\n')
            expect(await d.fs.stat('Root.md')).toBeNull()
          }
          await a.restart()
          await a.write('New.md', '---\ngroups: ["[[Renamed]]"]\n---\nafter rename\n')
          await rounds()
          for (const d of f.devices) expect(await d.text('New.md')).toContain('after rename')
          const counts = async () =>
            Promise.all(
              f.servers.map(async (s) => ({
                versions: (await s.db.selectFrom('versions').select('id').execute()).length,
                uploads: (await s.db.selectFrom('blob_uploads').selectAll().execute()).length,
                conflicts: (await s.db.selectFrom('conflict_divergences').selectAll().execute())
                  .length,
              }))
            )
          const before = await counts()
          const transfers = f.devices.map(
            (d) =>
              d.network.requests.filter(
                (r) => r.method === 'PUT' && new URL(r.url).pathname.startsWith('/v2/uploads/')
              ).length
          )
          await rounds(3, false)
          expect(await counts()).toEqual(before)
          expect(
            f.devices.map(
              (d) =>
                d.network.requests.filter(
                  (r) => r.method === 'PUT' && new URL(r.url).pathname.startsWith('/v2/uploads/')
                ).length
            )
          ).toEqual(transfers)
          console.info(`066: ${totalSyncs} syncs across the unchanged rename/restart/idle workflow`)
        } finally {
          await f.close()
        }
      },
      dialect === 'pg' ? 60_000 : 10_000
    )
  }
)
