import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'

/** The child must reach the requested cut, or fail with its exit/error diagnostics. */
export async function childBarrier(
  child: ChildProcess,
  cut: string,
  exited: Promise<unknown>,
  signal: AbortSignal,
  stderr: () => string
): Promise<unknown> {
  const waiting = new AbortController()
  const cancel = () => waiting.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    return await Promise.race([
      once(child, 'message', { signal: waiting.signal }).then(([value]) => value),
      exited.then(() => {
        throw new Error(`approval exited before ${cut}: ${stderr()}`)
      }),
    ])
  } finally {
    signal.removeEventListener('abort', cancel)
    waiting.abort()
  }
}
