import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The compose file as shipped. With `--profile tls` Caddy terminates TLS in front of the
 * server; a server port published on every interface beside it would be a way round TLS for
 * passwords and device tokens. So the port is published on loopback unless the operator says
 * otherwise, whichever profile runs: Caddy reaches the server over the compose network, and
 * only a host-side client uses the published port.
 */

const compose = readFileSync(
  fileURLToPath(new URL('../../../../docker-compose.example.yml', import.meta.url)),
  'utf8'
)

/** The port mappings listed under the `server` service. */
function serverPorts(): string[] {
  const server = compose.slice(compose.indexOf('\n  server:'), compose.indexOf('\n  postgres:'))
  const block = server.slice(server.indexOf('ports:'))
  return [...block.matchAll(/^\s+- '([^']+)'/gm)].map((m) => m[1] ?? '').slice(0, 1)
}

describe('docker-compose.example.yml', () => {
  it('publishes the server port on loopback by default', () => {
    const [mapping] = serverPorts()
    expect(mapping).toBeDefined()
    // host:hostPort:containerPort, the host part defaulting to loopback.
    expect(mapping).toMatch(/^\$\{ABELE_BIND:-127\.0\.0\.1\}:/)
  })
})
