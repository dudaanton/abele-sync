import { AbeleError } from '@abele/sync-protocol'

/** A definitive refusal applies only to the atomic request that returned it. */
export const isFinalForBatch = (error: unknown): error is AbeleError =>
  error instanceof AbeleError &&
  error.status >= 400 &&
  error.status < 500 &&
  error.code !== 'rate_limited' &&
  error.code !== 'unauthorized' &&
  error.code !== 'forbidden'
