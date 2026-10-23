import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { childBarrier } from '../e2e/helpers/childBarrier.js'

afterEach(() => vi.useRealTimers())

function fixture() {
  const child = new EventEmitter() as ChildProcess
  const controller = new AbortController()
  let exit!: () => void
  const exited = new Promise<void>((resolve) => {
    exit = resolve
  })
  const wait = () =>
    childBarrier(child, 'before-state-commit', exited, controller.signal, () => 'child diagnostic')
  return { child, controller, exit, wait }
}

it('waits for the crash cut despite slow startup and durable approval work', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const result = f.wait().then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  await vi.advanceTimersByTimeAsync(6000)
  f.child.emit('message', { barrier: 'before-state-commit' })
  expect(await result).toEqual({ value: { barrier: 'before-state-commit' } })
  expect(f.child.listenerCount('message')).toBe(0)
})

it('reports an early exit instead of waiting for a missing cut', async () => {
  const f = fixture(),
    waiting = f.wait()
  f.exit()
  await expect(waiting).rejects.toThrow(
    'approval exited before before-state-commit: child diagnostic'
  )
  expect(f.child.listenerCount('message')).toBe(0)
})

it('propagates child process errors', async () => {
  const f = fixture(),
    waiting = f.wait()
  f.child.emit('error', new Error('spawn failed'))
  await expect(waiting).rejects.toThrow('spawn failed')
  expect(f.child.listenerCount('message')).toBe(0)
})

it('cancels the wait when the enclosing test deadline expires', async () => {
  const f = fixture(),
    waiting = f.wait()
  f.controller.abort(new Error('test deadline'))
  await expect(waiting).rejects.toMatchObject({
    name: 'AbortError',
    cause: new Error('test deadline'),
  })
  expect(f.child.listenerCount('message')).toBe(0)
})
