import { EngineError } from './errors.js'

/** Deliberate interruption, distinct from a transport failure and its retry policy. */
export class SyncCancelled extends EngineError {
  constructor() {
    super('offline', 'sync stopped')
  }
}

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SyncCancelled()
}
