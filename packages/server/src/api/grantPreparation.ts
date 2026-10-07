import { toAbeleError } from './errors.js'

/** The mutation is already committed. Never turn a preparation failure into a
 * mutation error that encourages another create/PATCH. Return the saved identity
 * and revision; only the explicit preparation endpoint should be retried.
 */
export async function withGrantPreparation<T extends { state: string }>(
  grant: T,
  prepare: () => Promise<{ state: T['state'] }>
) {
  try {
    const result = await prepare()
    return { ...grant, state: result.state, preparation: { ok: true, state: result.state } }
  } catch (error) {
    return { ...grant, preparation: { ok: false, error: toAbeleError(error).toBody().error } }
  }
}
