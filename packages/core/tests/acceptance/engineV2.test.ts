import { expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'

it('012/027/028/031 production engines converge three devices through two servers and remain quiescent after restart', async () => {
  const f = await acceptanceFixture()
  try {
    const [a, b, c] = f.devices
    await a!.write('Shared/Note.md', 'one\ntwo\n')
    for (let round = 0; round < 5; round++)
      for (const device of f.devices)
        for (const id of device.connections.keys()) await device.sync(id)
    for (const device of f.devices) expect(await device.text('Shared/Note.md')).toBe('one\ntwo\n')
    await b!.write('Shared/Note.md', 'ONE\ntwo\n')
    for (let round = 0; round < 5; round++)
      for (const device of [b!, c!, a!])
        for (const id of device.connections.keys()) await device.sync(id)
    for (const device of f.devices) expect(await device.text('Shared/Note.md')).toBe('ONE\ntwo\n')
    await c!.restart()
    const count = async () =>
      Promise.all(
        f.servers.map(async (s) => ({
          versions: (await s.db.selectFrom('versions').select('id').execute()).length,
          uploads: (await s.db.selectFrom('blob_uploads').selectAll().execute()).length,
          conflicts: (await s.db.selectFrom('conflict_divergences').selectAll().execute()).length,
        }))
      )
    const before = await count()
    for (let round = 0; round < 3; round++)
      for (const device of f.devices)
        for (const id of device.connections.keys()) await device.sync(id)
    expect(await count()).toEqual(before)
    expect(
      f.devices
        .flatMap((d) => d.network.requests)
        .every((r) => new URL(r.url).pathname.startsWith('/v2/'))
    ).toBe(true)
  } finally {
    await f.close()
  }
})
