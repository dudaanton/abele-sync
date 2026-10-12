import { afterEach, expect, it } from 'vitest'
import { SyncEngine } from '../../src/index.js'
import { hasPgTestDb } from '@abele/sync-server/tests/helpers/tempDb.js'
import { sql } from 'kysely'
import { acceptanceFixture, type AcceptanceFixture } from './fixture.js'
let fixture: AcceptanceFixture | undefined
afterEach(async () => {
  await fixture?.close()
})
it('owns two real listeners, separate durable databases and three multi-connection production engines', async () => {
  fixture = await acceptanceFixture()
  expect(fixture.servers[0]!.address).not.toBe(fixture.servers[1]!.address)
  expect(fixture.servers[0]!.dir).not.toBe(fixture.servers[1]!.dir)
  expect(fixture.servers[0]!.databaseUrl).not.toBe(fixture.servers[1]!.databaseUrl)
  for (const device of fixture.devices) {
    expect(device.connections.size).toBe(2)
    for (const connection of device.connections.values())
      expect(connection.binding.engine).toBeInstanceOf(SyncEngine)
  }
  const [a, b, c] = fixture.devices
  await a!.write('Local.md', 'only A')
  expect(await b!.fs.stat('Local.md')).toBeNull()
  expect(await c!.fs.stat('Local.md')).toBeNull()
  await a!.restart()
  expect(a!.connections.size).toBe(2)
  expect(await a!.text('Local.md')).toBe('only A')
})
it.skipIf(!hasPgTestDb)(
  'PostgreSQL servers own different databases, not just separate schemas',
  async () => {
    fixture = await acceptanceFixture('pg')
    const names = await Promise.all(
      fixture.servers.map(
        async (server) =>
          (await sql<{ name: string }>`select current_database() as name`.execute(server.db))
            .rows[0]!.name
      )
    )
    expect(names[0]).not.toBe(names[1])
  }
)
