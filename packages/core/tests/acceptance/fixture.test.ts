import { afterEach, expect, it } from 'vitest'
import { SyncEngine } from '../../src/index.js'
import { hasPgTestDb } from '@abele/sync-server/tests/helpers/tempDb.js'
import { sql } from 'kysely'
import { connect } from 'node:net'
import { once } from 'node:events'
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

it('reads a normalized note name through the spelling present on disk', async () => {
  fixture = await acceptanceFixture()
  const device = fixture.devices[0]!
  await device.write('Notes/Café.md'.normalize('NFD'), 'decomposed name')
  expect(await device.text('Notes/Café.md')).toBe('decomposed name')
})

it('closes owned listeners without waiting for unfinished HTTP connections', async () => {
  fixture = await acceptanceFixture()
  const sockets = fixture.servers.map((server) =>
    connect(Number(new URL(server.address).port), '127.0.0.1')
  )
  const errors: NodeJS.ErrnoException[] = []
  for (const socket of sockets) socket.on('error', (error) => errors.push(error))
  const closed = sockets.map(
    (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()))
  )
  try {
    await Promise.all(sockets.map((socket) => once(socket, 'connect')))
    for (const socket of sockets) socket.write('GET /healthz HTTP/1.1\r\nHost: localhost\r\n')
    const closing = fixture.close()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        closing,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('fixture shutdown stalled')), 1000)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await Promise.all(closed)
      await closing
      fixture = undefined
    }
    // Linux may report EOF; macOS may reset an incomplete request on forced close.
    expect(errors.map((error) => error.code).every((code) => code === 'ECONNRESET')).toBe(true)
  } finally {
    for (const socket of sockets) socket.destroy()
  }
})
