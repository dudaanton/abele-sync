import {
  buildTestApp,
  TEST_PASSWORD,
  type TestApp,
  type TestAppOptions,
} from '@abele/sync-server/tests/helpers/testApp.js'
import { SyncClient, type ClientOptions, type VaultClient } from '../../src/index.js'
import { fetchFor, wsFor } from './serverFetch.js'

/** The base url every client is given. Only its scheme and shape matter; the host never resolves. */
export const BASE_URL = 'http://abele.test'

/** The password `buildTestApp` gives every account it makes, for a test that logs in itself. */
export { TEST_PASSWORD }

export interface Harness extends Pick<
  TestApp,
  'app' | 'hub' | 'db' | 'store' | 'account' | 'vault' | 'device'
> {
  /** A `fetch` over the running app, for a test that wants to make its own client. */
  fetch: typeof fetch
  close(): Promise<void>
  /** A client on an account token: logging in, vaults, devices. */
  clientOn(token: string, extra?: Partial<ClientOptions>): SyncClient
  /** A client on a device token, bound to its vault: everything the engine calls. */
  clientFor(deviceToken: string, vaultId: string, extra?: Partial<ClientOptions>): VaultClient
}

/**
 * A whole server in this process, and clients that talk to it exactly as they
 * would talk to one over a network. The app listens on a free port as well, so
 * `subscribe` has a real socket to open.
 */
export async function serverHarness(opts: TestAppOptions = {}): Promise<Harness> {
  const app: TestApp = await buildTestApp(opts)
  const fetch = fetchFor(app.app)
  const WebSocketBound = await wsFor(app.app)

  const clientOn = (token: string, extra: Partial<ClientOptions> = {}): SyncClient =>
    new SyncClient({ baseUrl: BASE_URL, fetch, WebSocket: WebSocketBound, token, ...extra })

  return {
    app: app.app,
    hub: app.hub,
    db: app.db,
    store: app.store,
    fetch,
    close: () => app.close(),
    account: (email?: string) => app.account(email),
    vault: (accountToken: string, name?: string) => app.vault(accountToken, name),
    device: (accountToken: string, vaultId: string, name?: string) =>
      app.device(accountToken, vaultId, name),
    clientOn,
    clientFor: (deviceToken, vaultId, extra) => clientOn(deviceToken, extra).forVault(vaultId),
  }
}
