import { expect } from 'vitest'
import { isDeepStrictEqual } from 'node:util'
import { sha256 } from '../../src/hash.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import type { AcceptanceFixture } from './fixture.js'

export const conflictServerFacets = new Set(Array.from({ length: 10 }, (_, i) => i + 91))

export async function settle(f: AcceptanceFixture, rounds = 5) {
  for (let round = 0; round < rounds; round++)
    for (const d of f.devices) for (const id of d.connections.keys()) await d.sync(id)
}

/** Drive completed syncs until every replica and ledger has the expected note.
 * Bound work by rounds, not a polling clock; an unchanged wrong merge still fails.
 */
async function settleMerged(
  f: AcceptanceFixture,
  owners: V2SyncClient[],
  path: string,
  text: string,
  rounds: number
) {
  const sha = await sha256(new TextEncoder().encode(text))
  const expected = {
    servers: owners.map(() => [{ path, sha }]),
    devices: f.devices.map((device) => ({
      paths: [path],
      text,
      connections: [...device.connections].map(() => ({
        sha,
        currentVersion: true,
        pending: 0,
        status: 'idle',
        journal: null,
      })),
    })),
  }
  let observed: unknown
  for (let round = 0; round < rounds; round++) {
    await settle(f, 1)
    const heads = await Promise.all(
      owners.map(async (owner) =>
        (await owner.manifest()).items.filter((item) => item.path.startsWith('Notes/'))
      )
    )
    const devices = []
    for (const device of f.devices) {
      const paths = []
      for await (const item of device.fs.list())
        if (item.path.startsWith('Notes/')) paths.push(item.path)
      const connections = []
      for (const connection of device.connections.values()) {
        const { state, engine } = connection.binding
        const entry = await state.get(path)
        const server = f.servers.findIndex(
          (server) => server.address === connection.access.token.address
        )
        connections.push({
          sha: entry?.sha ?? null,
          currentVersion:
            entry !== null &&
            entry.versionId === heads[server]?.find((item) => item.path === path)?.version_id,
          pending: engine.status.pending,
          status: engine.status.state,
          journal: await state.getJournal(),
        })
      }
      devices.push({
        paths: paths.sort(),
        text: (await device.fs.stat(path)) === null ? null : await device.text(path),
        connections,
      })
    }
    observed = {
      servers: heads.map((items) =>
        items.map((item) => ({ path: item.path, sha: 'sha' in item ? item.sha : null }))
      ),
      devices,
    }
    if (isDeepStrictEqual(observed, expected)) return
  }
  expect(
    observed,
    `note replicas and ledgers did not converge after ${rounds} completed rounds`
  ).toEqual(expected)
}

export async function counts(f: AcceptanceFixture) {
  return Promise.all(
    f.servers.map(async (s) => ({
      versions: await s.db.selectFrom('versions').select('id').orderBy('id').execute(),
      conflicts: await s.db
        .selectFrom('conflict_divergences')
        .selectAll()
        .orderBy('conflict_file_id')
        .execute(),
      uploads: await s.db.selectFrom('blob_uploads').selectAll().orderBy('sha').execute(),
    }))
  )
}

/** Production engines forward bytes between independent servers, never direct DB writes. */
export async function conflictServerFacet(number: number, f: AcceptanceFixture) {
  const [a, b, c] = f.devices
  const owners = f.roots.map((r) => new V2SyncClient(r.token))
  const path = 'Notes/Member.md'
  let prefix = ''
  const readers: V2SyncClient[][] = []
  if (number === 99) {
    // This facet provisions group connections itself. Creating six folder
    // connections only to close their durable stores adds no tested behavior.
    for (const d of f.devices) {
      expect(d.connections.size).toBe(0)
      d.network.limitRequests(1000)
    }
    for (const [i, owner] of owners.entries()) {
      const tokens: string[] = []
      const clients: V2SyncClient[] = []
      for (const name of ['One', 'Two', 'Private']) {
        const root = await owner.create(`Groups/${name}.md`, `${name}\n`)
        if (root.status === 'rejected') throw new Error(root.message)
        const token = await owner.json('/tokens', 'POST', {
          scope: { kind: 'group', id: root.file_id },
          label: name,
        })
        tokens.push(token.token)
        clients.push(new V2SyncClient(token.token))
      }
      readers.push(clients)
      for (const [index, d] of f.devices.entries())
        await d.paste(tokens[index === 1 ? 1 : 0]!, `server-${i + 1}`)
    }
    prefix = '---\ngroups: ["[[Groups/One]]", "[[Groups/Two]]"]\ncustom: kept\n---\n'
  }
  await a!.write(path, prefix + 'base\ntail\n')
  if (number === 91) await settleMerged(f, owners, path, 'base\ntail\n', 5)
  else await settle(f)
  const first = prefix + (number === 94 ? 'first\nFIRST\n' : 'first\ntail\n')
  const second =
    prefix +
    (number === 91
      ? 'base\nTAIL\n'
      : number === 93
        ? 'first\ntail\n'
        : number === 94
          ? 'second\nSECOND\n'
          : 'second\ntail\n')
  await a!.write(path, first)
  await a!.sync('server-1')
  // The competing device sends through the other server, from the same original base.
  await b!.write(path, second)
  let existingCopy: string | undefined
  if ([95, 96, 98, 100].includes(number)) {
    if (number === 96) {
      b!.network.dropNextResponse(
        (url, method) => url === f.servers[0]!.address + '/v2/commit' && method === 'POST'
      )
      await expect(b!.sync('server-1')).rejects.toMatchObject({ code: 'offline' })
      await b!.restart()
    }
    await b!.sync('server-1')
    if (number === 95) {
      await c!.write(path, second)
      await c!.sync('server-1')
    } else await c!.sync('server-1')
    const existing = (await owners[0]!.manifest()).items.filter((i) => i.path.startsWith('Notes/'))
    expect(existing).toHaveLength(2)
    existingCopy = existing.find((i) => i.path !== path)!.path
    await c!.sync('server-2')
  } else {
    await b!.sync('server-2')
    await c!.sync('server-2')
    await c!.sync('server-1')
  }
  // Finish the bridge's round trip before other devices forward stale branches.
  // This measures forwarding one resolved conflict, not independent resolutions
  // on both servers (whose first-arrival winners can legitimately differ).
  await c!.sync('server-2')
  if (number === 91) await settleMerged(f, owners, path, 'first\nTAIL\n', 7)
  else await settle(f, 7)
  const snapshots = await Promise.all(owners.map(async (o) => (await o.manifest()).items))
  const notes = snapshots.map((items) => items.filter((i) => i.path.startsWith('Notes/')))
  const merged = number === 91 || number === 93
  for (const items of notes) {
    expect(items).toHaveLength(merged ? 1 : 2)
    expect(items.filter((i) => i.path === path)).toHaveLength(1)
    expect(items.filter((i) => i.path.includes('(Conflicted copy '))).toHaveLength(merged ? 0 : 1)
  }
  const paths = notes[0]!.map((i) => i.path).sort()
  expect(notes[1]!.map((i) => i.path).sort()).toEqual(paths)
  if (existingCopy) expect(paths).toContain(existingCopy)
  const expected = merged ? [number === 91 ? 'first\nTAIL\n' : first] : [first, second].sort()
  for (const d of f.devices) {
    expect(await d.text(path)).toBe(merged ? expected[0] : first)
    expect((await Promise.all(paths.map((p) => d.text(p)))).sort()).toEqual(expected)
    const local: string[] = []
    for await (const item of d.fs.list()) if (item.path.startsWith('Notes/')) local.push(item.path)
    expect(local.sort()).toEqual(paths)
  }
  for (const [i, owner] of owners.entries())
    expect(
      (await Promise.all(notes[i]!.map((item) => owner.content(item.file_id))))
        .map((bytes) => bytes.toString())
        .sort()
    ).toEqual(expected)
  if (number === 99) {
    for (const clients of readers) {
      for (const client of clients.slice(0, 2)) {
        const visible = (await client.manifest()).items.filter((i) => i.path.startsWith('Notes/'))
        expect(visible.map((i) => i.path).sort()).toEqual(paths)
        expect(
          (await Promise.all(visible.map((i) => client.content(i.file_id))))
            .map((bytes) => bytes.toString())
            .sort()
        ).toEqual(expected)
      }
      const privateClient = clients[2]!
      expect((await privateClient.manifest()).items.some((i) => i.path.startsWith('Notes/'))).toBe(
        false
      )
      for (const item of notes[readers.indexOf(clients)]!)
        await expect(privateClient.content(item.file_id)).rejects.toMatchObject({ status: 404 })
    }
  }
  const before = await counts(f)
  await c!.restart()
  if (number === 91) await settleMerged(f, owners, path, 'first\nTAIL\n', 3)
  else await settle(f, 3)
  expect(await counts(f)).toEqual(before)
  for (const d of f.devices)
    expect((await Promise.all(paths.map((p) => d.text(p)))).sort()).toEqual(expected)
}
