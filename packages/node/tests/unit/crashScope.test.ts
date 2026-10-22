import { expect, it } from 'vitest'
import { crashScope } from '../helpers/crashScope.js'

it('a late replay cannot change the injector of the next test', async () => {
  const scope = crashScope(() => ({ cut: 0, dead: false }))
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const previous = scope.run(async () => {
    scope.state.cut = 400
    await waiting
    scope.state.dead = true
  })
  await scope.run(async () => {
    scope.state.cut = 0
    release()
    await previous
    expect(scope.state.dead).toBe(false)
    expect(scope.state.cut).toBe(0)
  })
})
