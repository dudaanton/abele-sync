import { expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { acceptanceFixture } from './fixture.js'

it('joins an in-flight fixture teardown and waits for every resource and directory', async () => {
  const f = await acceptanceFixture('sqlite')
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const device = f.devices[0]!,
    close = device.close.bind(device)
  const closing = vi.spyOn(device, 'close').mockImplementation(async () => {
    entered()
    await blocked
    await close()
  })
  const first = f.close()
  await ready
  const second = f.close()
  try {
    expect(closing).toHaveBeenCalledTimes(1)
    expect(existsSync(f.dir)).toBe(true)
  } finally {
    release()
    await Promise.allSettled([first, second])
  }
  await Promise.all([first, second])
  expect(existsSync(f.dir)).toBe(false)
  for (const device of f.devices) expect(device.connections.size).toBe(0)
})
