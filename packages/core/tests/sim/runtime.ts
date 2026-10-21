import { vi } from 'vitest'
import type { SimScheduler } from './scheduler.js'

/** Core still has global UUID/random/time call sites; contain them to one fixture. */
export function seededRuntime(scheduler: SimScheduler) {
  const random = vi.spyOn(Math, 'random').mockImplementation(scheduler.random)
  const uuid = vi
    .spyOn(globalThis.crypto, 'randomUUID')
    .mockImplementation(
      () => scheduler.uuid() as `${string}-${string}-${string}-${string}-${string}`
    )
  const now = vi.spyOn(Date, 'now').mockImplementation(() => scheduler.time)
  return () => {
    random.mockRestore()
    uuid.mockRestore()
    now.mockRestore()
  }
}
