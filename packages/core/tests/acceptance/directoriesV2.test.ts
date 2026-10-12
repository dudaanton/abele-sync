import { expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'

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
