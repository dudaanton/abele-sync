import { expect, vi } from 'vitest'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { decodeAccessToken } from '@abele/sync-protocol'
import type { EngineOptions } from '../../src/index.js'
import type { AcceptanceFixture } from './fixture.js'
import { counts, settle } from './serverConflicts.js'

export const remainingServerFacets = new Set([
  2,
  3,
  8,
  10,
  ...Array.from({ length: 8 }, (_, i) => i + 83),
  ...Array.from({ length: 7 }, (_, i) => i + 101),
])
// This facet performs thousands of serial durable stage/metadata fsyncs. Container
// overlay/bind mounts can make those much slower than local APFS. Keep a generous
// deadlock ceiling; the request budget below catches unbounded HTTP work by count.
export const MANY_FILES_MS = 30 * 60_000
export function facetEngineOptions(number: number): Pick<EngineOptions, 'defer'> {
  return number >= 83 && number <= 90
    ? {
        defer: (path) =>
          path.startsWith('Scripts/') || path.endsWith('.js') || path.startsWith('.obsidian/'),
      }
    : {}
}

export async function remainingServerFacet(number: number, f: AcceptanceFixture) {
  const [a, b, c] = f.devices
  const owners = f.roots.map((r) => new V2SyncClient(r.token))
  if ([2, 3, 8, 10].includes(number)) {
    await a!.write('Note.md', 'persisted\n')
    await a!.sync('server-1')
    if (number === 8) {
      const before = [...c!.connections.keys()]
      c!.network.disconnect(f.servers[0]!.address)
      await expect(c!.paste(f.roots[0]!.token, 'retry')).rejects.toMatchObject({ code: 'offline' })
      expect([...c!.connections.keys()]).toEqual(before)
      c!.network.reconnect(f.servers[0]!.address)
      await c!.paste(f.roots[0]!.token, 'retry')
      await c!.sync('retry')
      expect(await c!.text('Note.md')).toBe('persisted\n')
    } else if (number === 10) {
      await b!.sync('server-1')
      const tokens = [...b!.connections].map(([id, value]) => [id, value.token])
      await b!.restart()
      expect([...b!.connections].map(([id, value]) => [id, value.token])).toEqual(tokens)
      await b!.write('Note.md', 'after restart\n')
      await b!.sync('server-1')
      await a!.sync('server-1')
      expect(await a!.text('Note.md')).toBe('after restart\n')
    } else {
      const token = f.roots[0]!.token
      const info = number === 3 ? await c!.qr(token, 'decoded-qr') : await c!.paste(token, 'pasted')
      expect(info.scope).toEqual(f.roots[0]!.info.scope)
      expect(decodeAccessToken(token).address).toBe(f.servers[0]!.address)
      await c!.sync(number === 3 ? 'decoded-qr' : 'pasted')
      expect(await c!.text('Note.md')).toBe('persisted\n')
    }
    return
  }
  if (number >= 83 && number <= 90) return scriptFacet(number, f)
  if (number === 103) {
    await a!.fs.mkdir('Empty')
    a!.network.dropNextResponse(
      (url, method) => url === f.servers[0]!.address + '/v2/commit' && method === 'POST'
    )
    await expect(a!.sync('server-1')).rejects.toMatchObject({ code: 'offline' })
    await f.servers[0]!.restart()
    await a!.restart()
    await a!.sync('server-1')
    await a!.write('Note.md', 'durable\n')
    a!.network.dropNextResponse(
      (url, method) => url === f.servers[0]!.address + '/v2/commit' && method === 'POST'
    )
    await expect(a!.sync('server-1')).rejects.toMatchObject({ code: 'offline' })
    expect(await a!.connection('server-1').binding.state.getJournal()).not.toBeNull()
    await a!.restart()
    await settle(f)
    expect(await a!.connection('server-1').binding.state.getJournal()).toBeNull()
    for (const d of f.devices) expect(await d.text('Note.md')).toBe('durable\n')
    const before = await counts(f)
    await settle(f, 2)
    expect(await counts(f)).toEqual(before)
    return
  }
  if (number === 101 || number === 102) {
    await a!.write('Note.md', 'base\ntail\n')
    await settle(f)
    a!.network.disconnect(f.servers[0]!.address)
    if (number === 101) a!.network.disconnect(f.servers[1]!.address)
    await a!.write('Note.md', 'offline\ntail\n')
    await expect(a!.sync('server-1')).rejects.toMatchObject({ code: 'offline' })
    expect(await a!.text('Note.md')).toBe('offline\ntail\n')
    if (number === 102) {
      await a!.sync('server-2')
      await c!.sync('server-2')
      expect(await c!.text('Note.md')).toBe('offline\ntail\n')
      const item = (await owners[0]!.manifest()).items.find((i) => i.path === 'Note.md')!
      expect((await owners[0]!.content(item.file_id)).toString()).toBe('base\ntail\n')
    } else {
      await b!.write('Note.md', 'base\nremote\n')
      await b!.sync('server-1')
    }
    for (const s of f.servers) a!.network.reconnect(s.address)
    await a!.sync('server-1')
    await a!.sync('server-2')
    await settle(f)
    for (const d of f.devices)
      expect(await d.text('Note.md')).toBe(number === 101 ? 'offline\nremote\n' : 'offline\ntail\n')
    return
  }
  if ([104, 105, 106].includes(number)) {
    const server = f.servers[0]!
    const row = await server.db
      .selectFrom('spaces')
      .select(['id', 'settings'])
      .executeTakeFirstOrThrow()
    const settings = JSON.parse(row.settings)
    const limited = {
      ...settings,
      ...(number === 105 ? { quota_bytes: 4 } : { max_file_bytes: 4 }),
    }
    await server.db
      .updateTable('spaces')
      .set({ settings: JSON.stringify(limited) })
      .where('id', '=', row.id)
      .execute()
    await owners[0]!.create('Remote.md', 'ok')
    await a!.write('Rejected.md', 'retained local bytes\n')
    await a!.write('Good.md', 'ok')
    const report = await a!.sync('server-1')
    const refused = report.push.rejected.find((r) => 'path' in r.op && r.op.path === 'Rejected.md')
    expect(refused).toMatchObject({ code: number === 105 ? 'quota_exceeded' : 'too_large' })
    expect(refused!.message.length).toBeGreaterThan(0)
    expect(await a!.text('Rejected.md')).toBe('retained local bytes\n')
    expect(await a!.text('Remote.md')).toBe('ok')
    expect(a!.connection('server-1').binding.engine.status.pending).toBeGreaterThan(0)
    await a!.sync('server-2')
    await c!.sync('server-2')
    expect(await c!.text('Rejected.md')).toBe('retained local bytes\n')
    expect((await owners[0]!.manifest()).items.map((i) => i.path)).not.toContain('Rejected.md')
    expect((await owners[0]!.manifest()).items.map((i) => i.path)).toContain('Good.md')
    await server.db
      .updateTable('spaces')
      .set({ settings: row.settings })
      .where('id', '=', row.id)
      .execute()
    await a!.sync('server-1')
    const accepted = (await owners[0]!.manifest()).items.find((i) => i.path === 'Rejected.md')!
    expect((await owners[0]!.content(accepted.file_id)).toString()).toBe('retained local bytes\n')
    expect(a!.connection('server-1').binding.engine.status.pending).toBe(0)
    if (number === 105) {
      // A real HTTP upload hitting a storage error, without filling the host disk.
      const full = vi
        .spyOn(server.store, 'put')
        .mockRejectedValue(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
      try {
        await a!.write('Disk.md', 'keep on disk\n')
        await expect(a!.sync('server-1')).rejects.toMatchObject({ status: 500 })
        expect(await a!.text('Disk.md')).toBe('keep on disk\n')
        expect(a!.connection('server-1').binding.engine.status).toMatchObject({ state: 'error' })
        expect(a!.connection('server-1').binding.engine.status.pending).toBeGreaterThan(0)
        expect(await a!.connection('server-1').binding.state.getJournal()).not.toBeNull()
        await a!.sync('server-2')
        await c!.sync('server-2')
        expect(await c!.text('Disk.md')).toBe('keep on disk\n')
      } finally {
        full.mockRestore()
      }
      await a!.sync('server-1')
      expect(await a!.connection('server-1').binding.state.getJournal()).toBeNull()
      const disk = (await owners[0]!.manifest()).items.find((i) => i.path === 'Disk.md')!
      expect((await owners[0]!.content(disk.file_id)).toString()).toBe('keep on disk\n')
    }
    return
  }
  if (number === 107) {
    for (const device of f.devices) device.network.limitRequests(10_000)
    // More than one manifest page and one commit batch; no wall-clock speed assertion.
    for (let i = 0; i < 1005; i++) await a!.write(`Many/${i}.md`, `note ${i}\n`)
    await settle(f, 3)
    for (const owner of owners) {
      const seen: string[] = []
      let next: string | null = null
      let pages = 0
      do {
        // 1,005 files plus their directory fit in 33 pages. A repeated cursor
        // must fail by work count, even with a generous slow-disk time budget.
        expect(++pages).toBeLessThanOrEqual(33)
        const page = await owner.manifest(
          next ? '?next=' + encodeURIComponent(next) + '&limit=31' : '?limit=31'
        )
        seen.push(...page.items.filter((i) => i.kind !== 'directory').map((i) => i.path))
        next = page.next
      } while (next)
      expect(new Set(seen).size).toBe(1005)
    }
    for (const d of f.devices) {
      for (let i = 0; i < 1005; i++) expect(await d.text(`Many/${i}.md`)).toBe(`note ${i}\n`)
      for (const { binding } of d.connections.values()) {
        expect(binding.engine.status.state).toBe('idle')
        expect(binding.engine.status.pending).toBe(0)
      }
    }
    const before = await counts(f)
    await settle(f, 2)
    expect(await counts(f)).toEqual(before)
    return
  }
  throw new Error(`No remaining server facet for ${number}`)
}

async function scriptFacet(number: number, f: AcceptanceFixture) {
  const [a, b, c] = f.devices
  const owners = f.roots.map((r) => new V2SyncClient(r.token))
  const path = 'Scripts/example.js'
  const old = 'old script\n',
    incoming = 'review this script\n'
  const engine = () => b!.connection('server-1').binding.engine
  const publish = async (bytes: string, owner = owners[0]!) => {
    const item = (await owner.manifest()).items.find((i) => i.path === path)
    if (!item) return owner.create(path, bytes, 2000)
    return (
      await owner.commit([
        {
          op: 'modify',
          file_id: item.file_id,
          base_version_id: item.version_id,
          ...(await owner.upload(Buffer.from(bytes))),
          mtime: 3000,
        },
      ])
    ).results[0]!
  }
  if (number === 84) {
    const dir = (await owners[0]!.commit([{ op: 'mkdir', path: 'Shared' }])).results[0]!
    if (dir.status === 'rejected') throw new Error(dir.message)
    const share = await owners[0]!.share(dir.file_id)
    for (const id of [...b!.connections.keys()]) await b!.disconnect(id)
    await b!.paste(share.token, 'folder')
    await owners[0]!.create('.obsidian/app.json', '{}')
    await owners[0]!.create('Shared/example.js', incoming)
    await b!.sync('folder')
    expect(await b!.fs.stat('.obsidian/app.json')).toBeNull()
    expect(await b!.fs.stat('Shared/example.js')).toBeNull()
    const staged = await b!.connection('folder').binding.engine.deferred()
    expect(staged.map((i) => i.path)).toEqual(['Shared/example.js'])
    const root = await owners[0]!.create('Groups/Root.md', 'root\n')
    if (root.status === 'rejected') throw new Error(root.message)
    const token = await owners[0]!.json('/tokens', 'POST', {
      scope: { kind: 'group', id: root.file_id },
      label: 'Group',
    })
    const group = new V2SyncClient(token.token)
    expect((await group.manifest()).items.map((i) => i.path)).not.toContain('.obsidian/app.json')
    expect(await group.create('.obsidian/forbidden.json', '{}')).toMatchObject({
      status: 'rejected',
      code: 'forbidden',
    })
    return
  }
  if (number !== 85 && number !== 83) {
    await b!.write(path, old)
    await b!.sync('server-1')
  }
  await publish(incoming)
  await owners[0]!.create('Note.md', 'ordinary file\n')
  if (number === 83) await owners[0]!.create('.obsidian/app.json', '{"setting":true}')
  if (number === 83) {
    await a!.write('.obsidian/appearance.json', '{"theme":"local"}')
    await a!.write('Scripts/local.js', 'authored locally\n')
    await a!.sync('server-1')
    await a!.sync('server-2')
    for (const owner of owners) {
      const items = (await owner.manifest()).items
      expect(items.map((i) => i.path)).toContain('.obsidian/appearance.json')
      expect(items.map((i) => i.path)).toContain('Scripts/local.js')
    }
  }
  await b!.sync('server-1')
  expect(await b!.text('Note.md')).toBe('ordinary file\n')
  if (number === 85 || number === 83) expect(await b!.fs.stat(path)).toBeNull()
  else expect(await b!.text(path)).toBe(old)
  const shown = (await engine().deferred()).find((i) => i.path === path)!
  expect(shown.sha).not.toBeNull()
  expect(shown.mtime).toBeGreaterThan(0)
  expect(shown.at).toBeTruthy()
  expect(decodeAccessToken(b!.connection('server-1').token).address).toBe(f.servers[0]!.address)
  expect(shown.actor.id).toBe(
    number === 85 || number === 83
      ? 'manifest'
      : (await b!.connection('server-1').access.connection()).token_id
  )
  expect(
    new TextDecoder().decode(
      await b!.connection('server-1').binding.client.versionBytes(shown.file_id, shown.version_id)
    )
  ).toBe(incoming)
  if (number === 83)
    expect((await engine().deferred()).map((i) => i.path).sort()).toEqual([
      '.obsidian/app.json',
      '.obsidian/appearance.json',
      path,
      'Scripts/local.js',
    ])
  if (number === 87 || number === 86) {
    expect((await engine().applyDeferred([shown.version_id])).applied).toContain(path)
    expect(await b!.text(path)).toBe(incoming)
    if (number === 86) {
      await publish('second review\n')
      await b!.sync('server-1')
      expect(await b!.text(path)).toBe(incoming)
      const next = (await engine().deferred()).find((i) => i.path === path)!
      expect(next.version_id).not.toBe(shown.version_id)
      await engine().applyDeferred([next.version_id])
      const head = (await owners[0]!.manifest()).items.find((i) => i.path === path)!
      const moved = (
        await owners[0]!.commit([
          {
            op: 'move',
            file_id: head.file_id,
            base_version_id: head.version_id,
            to_path: 'Scripts/renamed.js',
          },
        ])
      ).results[0]!
      if (moved.status === 'rejected') throw new Error(moved.message)
      await b!.sync('server-1')
      expect(await b!.text(path)).toBe('second review\n')
      expect(await b!.fs.stat('Scripts/renamed.js')).toBeNull()
      const rename = (await engine().deferred()).find((i) => i.path === 'Scripts/renamed.js')!
      await engine().applyDeferred([rename.version_id])
      expect(await b!.fs.stat(path)).toBeNull()
      expect(await b!.text('Scripts/renamed.js')).toBe('second review\n')
      await owners[0]!.commit([
        { op: 'delete', file_id: moved.file_id, base_version_id: moved.version_id },
      ])
      await b!.sync('server-1')
      expect(await b!.text('Scripts/renamed.js')).toBe('second review\n')
      const deletion = (await engine().deferred()).find((i) => i.path === 'Scripts/renamed.js')!
      expect(deletion.op).toBe('delete')
      await engine().applyDeferred([deletion.version_id])
      expect(await b!.fs.stat('Scripts/renamed.js')).toBeNull()
    }
  } else if (number === 88) {
    expect((await engine().keepLocal([path], [shown.version_id])).kept).toContain(path)
    expect(await b!.text(path)).toBe(old)
    await b!.sync('server-1')
    await owners[0]!.create('Later.md', 'still syncing\n')
    await b!.sync('server-1')
    expect(await b!.text('Later.md')).toBe('still syncing\n')
  } else if (number === 89) {
    await publish('superseding script\n')
    await b!.sync('server-1')
    const answer = await engine().applyDeferred([shown.version_id])
    expect(answer.applied).not.toContain(path)
    expect(answer.unshown!.map((i) => i.path)).toContain(path)
    expect(await b!.text(path)).toBe(old)
  } else if (number === 90) {
    await owners[1]!.create(path, 'other server script\n')
    await c!.sync('server-2')
    const other = (await c!.connection('server-2').binding.engine.deferred()).find(
      (i) => i.path === path
    )!
    expect(await c!.fs.stat(path)).toBeNull()
    await c!.restart()
    expect(await c!.connection('server-2').binding.engine.deferred()).toContainEqual(other)
    await b!.restart()
    expect(await engine().deferred()).toContainEqual(shown)
    expect(await b!.text(path)).toBe(old)
    expect(other.sha).not.toBe(shown.sha)
  }
}
