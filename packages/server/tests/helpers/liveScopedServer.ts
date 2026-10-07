import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { InjectOptions } from 'fastify'
import { buildApp } from '../../src/api/app.js'
import { loadConfig } from '../../src/config.js'
import { TEST_TOKEN_PEPPER } from './testApp.js'
import type { scopedFixture } from './scopedFixture.js'

/** Disposable TCP transport around the real switched buildApp. The wrapper only
 * records bytes and injects transport faults; all routes/parsing/auth are production.
 */
export async function liveScopedServer(f: Awaited<ReturnType<typeof scopedFixture>>) {
  const faults: { redirect?: string; dropCommit?: boolean } = {},
    requests: { path: string; token: string | undefined; bytes: number }[] = []
  const config = loadConfig({
    ABELE_MASTER_KEY: 'ab'.repeat(32),
    ABELE_TOKEN_PEPPER: TEST_TOKEN_PEPPER,
    ABELE_SCOPED_SHARING: 'on',
  })
  const start = (db: typeof f.t.db) =>
    buildApp({
      config,
      db,
      dialect: f.deps.dialect,
      store: f.t.store,
      hub: f.t.hub,
      now: f.deps.now,
    })
  let app = await start(f.t.db)
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const bytes = Buffer.concat(chunks),
      path = new URL(req.url!, 'http://localhost').pathname,
      token = req.headers.authorization?.replace(/^Bearer /, '')
    requests.push({ path, token, bytes: bytes.length })
    if (faults.redirect && path.includes('/v1/scoped/')) {
      res.writeHead(307, { location: faults.redirect })
      res.end()
      return
    }
    const response = await app.inject({
      method: req.method as InjectOptions['method'],
      url: req.url!,
      headers: req.headers,
      ...(bytes.length ? { payload: bytes } : {}),
    })
    if (faults.dropCommit && path.endsWith('/commit') && response.statusCode === 200) {
      faults.dropCommit = false
      req.socket.destroy()
      return
    }
    res.writeHead(response.statusCode, response.headers)
    res.end(response.rawPayload)
  }
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  config.publicUrl = base
  return {
    base,
    deps: { ...f.deps, endpointIdentity: base },
    requests,
    faults,
    useDatabase: async (db: typeof f.t.db) => {
      await app.close()
      app = await start(db)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      await app.close()
    },
  }
}
