import { AbeleError, normalizeServerUrl, ScopedStateResponseSchema } from '@abele/sync-protocol'
import { withScopedAuthority, type ScopedDeps } from './authority.js'
export type ScopedStateDeps = ScopedDeps & {
  endpointIdentity?: string
  config?: { publicUrl?: string }
}
/** State contains authority identity, never personal usage or a global watermark. */
export function readScopedState(
  deps: ScopedStateDeps,
  token: string,
  vaultId: string,
  grantId: string
) {
  return withScopedAuthority(deps, token, vaultId, grantId, 'receipt', async (_tx, a) => {
    const endpoint = normalizeServerUrl(
      deps.endpointIdentity ?? deps.config?.publicUrl ?? 'http://localhost:8787'
    )
    if (!endpoint) throw new AbeleError('scope_unavailable', 'issuer identity is unavailable')
    return ScopedStateResponseSchema.parse({
      endpoint_identity: endpoint,
      vault_id: vaultId,
      grant_id: grantId,
      principal_kind: a.principal.kind,
      principal_id: a.principal.principal_id,
      role: a.role,
      state: a.state,
      selector: a.selector,
    })
  })
}
