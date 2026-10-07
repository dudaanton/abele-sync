import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('routes TLS to the same configurable server port', () => {
  const root = new URL('../../../../', import.meta.url)
  const compose = readFileSync(fileURLToPath(new URL('docker-compose.example.yml', root)), 'utf8')
  const caddy = readFileSync(fileURLToPath(new URL('Caddyfile', root)), 'utf8')
  expect(compose).toMatch(/caddy:[\s\S]*?ABELE_PORT: \$\{ABELE_PORT:-8787\}/)
  expect(caddy).toContain('reverse_proxy server:{$ABELE_PORT}')
})
