import { expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { lstat, mkdir, rename, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

it('preserves server files when a canonical directory or file gets a new local inode', async () => {
  const f = await acceptanceFixture()
  try {
    const [a, b] = f.devices
    const path = 'й/note.md',
      replacement = 'й'.normalize('NFD')
    await a!.write(path, 'retained bytes\n')
    const settle = async () => {
      for (let round = 0; round < 3; round++)
        for (const device of f.devices)
          for (const id of device.connections.keys()) await device.sync(id)
    }
    await settle()
    const server = new V2SyncClient(f.roots[0]!.token)
    const before = await server.manifest()
    const directoryStat = await lstat(join(a!.root, 'й'))
    const noteStat = await lstat(join(a!.root, path))
    const original = join(f.dir, 'original-directory')
    await rename(join(a!.root, 'й'), original)
    await mkdir(join(a!.root, replacement))
    await rename(join(original, 'note.md'), join(a!.root, replacement, 'note.md'))
    expect((await lstat(join(a!.root, replacement))).ino).not.toBe(directoryStat.ino)
    expect((await lstat(join(a!.root, replacement, 'note.md'))).mtimeMs).toBe(noteStat.mtimeMs)
    await settle()
    expect(await server.manifest()).toEqual(before)
    expect(await a!.text(replacement + '/note.md')).toBe('retained bytes\n')
    expect(await b!.text(path)).toBe('retained bytes\n')
    const fresh = join(f.dir, 'replacement-file')
    await writeFile(fresh, 'retained bytes\n')
    await utimes(fresh, noteStat.atime, noteStat.mtime)
    expect((await lstat(fresh)).ino).not.toBe(noteStat.ino)
    await rename(fresh, join(a!.root, replacement, 'note.md'))
    await settle()
    expect(await server.manifest()).toEqual(before)
    expect(await a!.text(replacement + '/note.md')).toBe('retained bytes\n')
    expect(await b!.text(path)).toBe('retained bytes\n')
  } finally {
    await f.close()
  }
})

it('preserves file and directory IDs through case-only renames', async () => {
  const f = await acceptanceFixture()
  try {
    const [a, b] = f.devices
    await a!.write('Й/Note.md', 'case rename bytes\n')
    await a!.fs.mkdir('Й-empty')
    const settle = async () => {
      for (let round = 0; round < 3; round++)
        for (const device of f.devices)
          for (const id of device.connections.keys()) await device.sync(id)
    }
    await settle()
    const server = new V2SyncClient(f.roots[0]!.token)
    const before = (await server.manifest()).items
    const directory = before.find((item) => item.path === 'Й')!
    const note = before.find((item) => item.path === 'Й/Note.md')!
    const empty = before.find((item) => item.path === 'Й-empty')!
    const raw = 'й'.normalize('NFD')
    await a!.fs.moveDirectory('Й', raw)
    await a!.fs.moveDirectory('Й-empty', 'й-empty'.normalize('NFD'))
    await settle()
    await a!.move(raw + '/Note.md', raw + '/note.md')
    await settle()
    const after = (await server.manifest()).items
    expect(after.find((item) => item.path === 'й')?.file_id).toBe(directory.file_id)
    expect(after.find((item) => item.path === 'й/note.md')?.file_id).toBe(note.file_id)
    // An empty inode-only rename has no descendant witness. Preserve the remote
    // identity at its original name rather than infer a recursive tree operation.
    expect(after.find((item) => item.path === 'Й-empty')?.file_id).toBe(empty.file_id)
    expect(after.some((item) => item.path === 'й-empty')).toBe(false)
    expect(after).toHaveLength(3)
    expect(await a!.text(raw + '/note.md')).toBe('case rename bytes\n')
    expect(await b!.text('й/note.md')).toBe('case rename bytes\n')
    expect(
      (await a!.connection('server-1').binding.client.versions(note.file_id)).some(
        (version) => version.op === 'delete'
      )
    ).toBe(false)
  } finally {
    await f.close()
  }
})

it('replays a lost directory commit response after restart without a second identity', async () => {
  const f = await acceptanceFixture()
  try {
    const a = f.devices[0]!
    await a.fs.mkdir('й-empty'.normalize('NFD'))
    a.network.dropNextResponse(
      (url, method) => url === f.servers[0]!.address + '/v2/commit' && method === 'POST'
    )
    await expect(a.sync('server-1')).rejects.toMatchObject({ code: 'offline' })
    const client = new V2SyncClient(f.roots[0]!.token)
    const before = await client.manifest()
    expect(before.items.filter((item) => item.path === 'й-empty')).toHaveLength(1)
    await a.restart()
    await a.sync('server-1')
    await a.sync('server-1')
    expect(await client.manifest()).toEqual(before)
  } finally {
    await f.close()
  }
})

// This bounded exchange takes 11–13 s alone on Linux/ext4; leave room for
// parallel-runner contention and durable cleanup.
it(
  'preserves decomposed directory spellings while two production vaults exchange Unicode children',
  async () => {
    const f = await acceptanceFixture()
    try {
      const [a, b] = f.devices
      const parent = 'Sample/й-folder'.normalize('NFD')
      const empty = parent + '/' + 'ё-empty'.normalize('NFD')
      const note = parent + '/' + 'й-note.md'.normalize('NFD')
      await a!.fs.mkdir(empty)
      await a!.write(note, 'initial\n')
      const settle = async () => {
        for (let round = 0; round < 4; round++)
          for (const d of f.devices) for (const id of d.connections.keys()) await d.sync(id)
      }
      await settle()
      const wire = new V2SyncClient(f.roots[0]!.token)
      const initial = (await wire.manifest()).items
      expect(initial.every((item) => item.path === item.path.normalize('NFC'))).toBe(true)
      expect(new Set(initial.map((item) => item.path)).size).toBe(initial.length)
      const original = initial.find((item) => item.path === note.normalize('NFC'))!
      const directory = initial.find((item) => item.path === parent.normalize('NFC'))!
      expect(initial.some((item) => item.path === empty.normalize('NFC'))).toBe(true)
      const rejected = await wire.commit([{ op: 'mkdir', path: 'Raw/й'.normalize('NFD') }])
      expect(rejected.results[0]).toMatchObject({ status: 'rejected', code: 'invalid_path' })
      expect(await b!.text(note.normalize('NFC'))).toBe('initial\n')
      await a!.write(note, 'edited on A\n')
      await settle()
      expect(await b!.text(note.normalize('NFC'))).toBe('edited on A\n')
      await b!.write(note.normalize('NFC'), 'edited on B\n')
      await settle()
      expect(await a!.text(note)).toBe('edited on B\n')
      await b!.write(parent.normalize('NFC') + '/ё-new.md', 'remote\n')
      await settle()
      const actual: string[] = []
      for await (const file of a!.fs.list()) actual.push(file.path)
      expect(actual).toContain(parent + '/ё-new.md')
      expect(await a!.text(note)).toBe('edited on B\n')
      const renamedParent = 'Sample/ё-renamed'.normalize('NFD')
      await a!.fs.moveDirectory(parent, renamedParent)
      await settle()
      const renamedNote = renamedParent + '/' + 'й-renamed.md'.normalize('NFD')
      await a!.move(renamedParent + '/' + 'й-note.md'.normalize('NFD'), renamedNote)
      await settle()
      const afterMove = (await wire.manifest()).items
      expect(afterMove.find((item) => item.path === renamedNote.normalize('NFC'))?.file_id).toBe(
        original.file_id
      )
      expect(afterMove.find((item) => item.path === renamedParent.normalize('NFC'))?.file_id).toBe(
        directory.file_id
      )
      const versions = await a!.connection('server-1').binding.client.versions(original.file_id)
      await a!.fs.moveDirectory(renamedParent, renamedParent.normalize('NFC'))
      await settle()
      expect(await a!.connection('server-1').binding.client.versions(original.file_id)).toEqual(
        versions
      )
      const first = versions.at(-1)!
      await a!.connection('server-1').binding.client.restore(original.file_id, first.version_id)
      await settle()
      // Restore returns the historic content under the current identity/path.
      expect(await b!.text(renamedNote.normalize('NFC'))).toBe('initial\n')
      // The parent was respelled above; its child retains its physical NFD basename.
      const localNote = renamedParent.normalize('NFC') + '/' + 'й-renamed.md'.normalize('NFD')
      await a!.write(localNote, 'first concurrent\ntail\n')
      await b!.write(renamedNote.normalize('NFC'), 'second concurrent\ntail\n')
      await a!.sync('server-1')
      await b!.sync('server-1')
      await settle()
      const contents: string[] = []
      for await (const file of a!.fs.list()) contents.push(await a!.text(file.path))
      expect(contents).toContain('first concurrent\ntail\n')
      expect(contents).toContain('second concurrent\ntail\n')
      await a!.delete(renamedParent.normalize('NFC') + '/ё-new.md')
      await settle()
      expect(await b!.fs.stat(renamedParent.normalize('NFC') + '/ё-new.md')).toBeNull()
      await b!.delete(renamedNote.normalize('NFC'))
      await settle()
      expect(await a!.fs.stat(localNote)).toBeNull()
      await a!.connection('server-1').binding.client.restoreDeleted(original.file_id)
      await settle()
      // Restore may create a new wire-spelled basename; inspect the physical entries.
      const restored: string[] = []
      for await (const file of a!.fs.list()) restored.push(file.path.normalize('NFC'))
      expect(restored).toContain(renamedNote.normalize('NFC'))
      await a!.fs.removeDirectory(renamedParent.normalize('NFC') + '/' + 'ё-empty'.normalize('NFD'))
      await settle()
      const directories: string[] = []
      for await (const dir of b!.fs.listDirectories()) directories.push(dir.path)
      expect(directories).not.toContain(renamedParent.normalize('NFC') + '/ё-empty')
      const before = await Promise.all(
        f.servers.map((s) => s.db.selectFrom('versions').select('id').execute())
      )
      await settle()
      await settle()
      expect(
        await Promise.all(f.servers.map((s) => s.db.selectFrom('versions').select('id').execute()))
      ).toEqual(before)
    } finally {
      await f.close()
    }
  },
  60 * 1_000
)

it('053/054/056 empty directory identities, moves, and deletions converge through the production engine', async () => {
  const f = await acceptanceFixture()
  try {
    const [a, b] = f.devices
    await a!.fs.mkdir('Shared/Empty')
    await a!.write('Shared/Sub/Note.md', 'bytes\n')
    const settle = async () => {
      for (let round = 0; round < 4; round++)
        for (const d of f.devices)
          for (const id of d.connections.keys()) {
            try {
              await d.sync(id)
            } catch (cause) {
              throw new Error(`sync ${d.name}/${id}`, { cause })
            }
          }
    }
    await settle()
    const dirs = async (index: number) => {
      const paths: string[] = []
      for await (const dir of f.devices[index]!.fs.listDirectories()) paths.push(dir.path)
      return paths
    }
    expect(await dirs(1)).toContain('Shared/Empty')
    await a!.fs.moveDirectory('Shared', 'Renamed')
    await settle()
    expect(await b!.text('Renamed/Sub/Note.md')).toBe('bytes\n')
    expect(await dirs(1)).toContain('Renamed/Empty')
    expect(await dirs(1)).not.toContain('Shared')
    await a!.delete('Renamed/Sub/Note.md')
    await a!.fs.removeDirectory('Renamed/Sub')
    await a!.fs.removeDirectory('Renamed/Empty')
    await a!.fs.removeDirectory('Renamed')
    await settle()
    expect(await dirs(1)).not.toContain('Renamed')
    expect(await b!.fs.stat('Renamed/Sub/Note.md')).toBeNull()
    const before = await Promise.all(
      f.servers.map((s) => s.db.selectFrom('versions').select('id').execute())
    )
    await settle()
    expect(
      await Promise.all(f.servers.map((s) => s.db.selectFrom('versions').select('id').execute()))
    ).toEqual(before)
  } finally {
    await f.close()
  }
})

it.each([true, false])(
  'joins existing NFC/NFD copies without losing local bytes (equal: %s)',
  async (equal) => {
    const f = await acceptanceFixture()
    try {
      const [a, b] = f.devices
      const wire = 'й-folder/ё-note.md'
      await a!.write(wire.normalize('NFD'), 'first\ntail\n')
      await b!.write(wire, equal ? 'first\ntail\n' : 'second\ntail\n')
      for (let round = 0; round < 5; round++)
        for (const device of f.devices)
          for (const id of device.connections.keys()) await device.sync(id)
      const content: string[] = []
      for await (const file of b!.fs.list())
        content.push(new TextDecoder().decode(await b!.fs.read(file.path)))
      expect(content).toContain('first\ntail\n')
      if (!equal) expect(content).toContain('second\ntail\n')
      if (equal) expect(content).toHaveLength(1)
      const snapshot = await new V2SyncClient(f.roots[0]!.token).manifest()
      expect(snapshot.items.every((item) => item.path === item.path.normalize('NFC'))).toBe(true)
    } finally {
      await f.close()
    }
  }
)
