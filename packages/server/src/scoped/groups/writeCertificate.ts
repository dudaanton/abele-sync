import type { ScopedAuthority } from '../authority.js'
/** Not a wire/config flag. Set only after live editor + caught-up view validation
 * under the vault fence; subsequent head growth is this unit's own protected work.
 */
export const groupWriteCertificate: unique symbol = Symbol('fenced-group-write')
export type GroupWriteAuthority = ScopedAuthority & { [groupWriteCertificate]?: true }
