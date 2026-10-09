import { ExternalStateError } from './state.js'

export interface RecoveryReadiness {
  assertReady(): void
}
/** Host opens/inspects durable journals under ownership, then explicitly activates.
 * Completing recovery is not a perpetual ownership grant: each effect rechecks the host.
 */
export class RecoveryBarrier implements RecoveryReadiness {
  private ready = false
  constructor(private readonly assertOwnership: () => void) {}
  activate(): void {
    this.assertOwnership()
    this.ready = true
  }
  hold(): void {
    this.ready = false
  }
  assertReady(): void {
    this.assertOwnership()
    if (!this.ready) throw new ExternalStateError('recovery-required')
  }
}
