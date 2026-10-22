import { expect, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'

it('stop drains the scoped page request without starting files, then resumes its durable work', async () => {
  const f = await acceptanceFixture()
  const a = f.devices[0]!
  const owner = new V2SyncClient(f.roots[0]!.token)
  const barrier = a.network.delayNextResponse(
    (url, method) => url.startsWith(owner.address + '/v2/manifest') && method === 'GET'
  )
  let syncing: Promise<unknown> | undefined
  let stopping: Promise<void> | undefined
  try {
    await owner.create('Shared/N.md', 'bytes\n')
    syncing = a.sync('server-1').catch((error: unknown) => error)
    await barrier.entered
    let stopped = false
    stopping = a
      .connection('server-1')
      .binding.engine.stop()
      .then(() => {
        stopped = true
      })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    barrier.release()
    await syncing
    await stopping
    expect(stopped).toBe(true)
    expect(await a.fs.stat('Shared/N.md')).toBeNull()
    expect(await a.connection('server-1').binding.state.get('Shared/N.md')).toBeNull()
    a.connection('server-1').binding.engine.resume()
    await a.sync('server-1')
    expect(await a.text('Shared/N.md')).toBe('bytes\n')
    const recorded = await a.connection('server-1').binding.state.get('Shared/N.md')
    expect(recorded?.sha).toBeDefined()
  } finally {
    barrier.release()
    await syncing
    await stopping
    await f.close()
  }
})
