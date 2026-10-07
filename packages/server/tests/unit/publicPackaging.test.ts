import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

it('ships a production-only non-root image pinned to a multi-platform base digest', () => {
  const dockerfile = read('packages/server/Dockerfile')
  for (const from of dockerfile.matchAll(/^FROM (\S+)/gm)) {
    if (from[1]!.includes(':')) expect(from[1]).toMatch(/@sha256:[a-f0-9]{64}$/)
  }
  expect(dockerfile).toContain('AS daemon')
  expect(dockerfile).toContain('AS server')
  expect(dockerfile).toContain('USER node')
  expect(dockerfile).toContain('HEALTHCHECK')
  expect(dockerfile).toMatch(/npm (ci --omit=dev|prune --omit=dev)/)
})

it('probes the server default port even when ABELE_PORT is empty', () => {
  const line = read('packages/server/Dockerfile')
    .split('\n')
    .find((line) => line.startsWith('HEALTHCHECK'))!
  const command: string[] = JSON.parse(line.slice(line.indexOf('["node"')))
  const script =
    'globalThis.fetch = async (url) => { if (url !== "http://127.0.0.1:8787/healthz") throw new Error("wrong port"); return {ok:true}; };' +
    command[2]
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, ABELE_PORT: '' },
  })
  expect(result.status).toBe(0)
})

it('starts PostgreSQL before the example server and keeps durable data in named volumes', () => {
  const compose = parse(read('docker-compose.example.yml'))
  expect(compose.services.server.depends_on.postgres.condition).toBe('service_healthy')
  expect(compose.services.postgres.healthcheck.test).toBeDefined()
  expect(compose.services.server.ports[0]).toMatch(/^\$\{ABELE_BIND:-127\.0\.0\.1\}:/)
  expect(compose.services.server.volumes).toContain('server-data:/data')
  expect(compose.services.postgres.volumes).toContain('postgres-data:/var/lib/postgresql/data')
  expect(compose.volumes).toHaveProperty('server-data')
  expect(compose.volumes).toHaveProperty('postgres-data')
})

it('documents every environment variable read by server configuration', () => {
  const variables = new Set(
    [...read('packages/server/src/config.ts').matchAll(/env\.(ABELE_[A-Z_]+)/g)].map((m) => m[1])
  )
  for (const name of variables) {
    expect(read('docs/deploy.md'), name).toContain('`' + name + '`')
    expect(read('.env.example'), name).toContain(name)
  }
})

it('pins every workflow action and limits package write permission to release', () => {
  for (const file of ['ci.yml', 'release.yml']) {
    const source = read('.github/workflows/' + file)
    for (const action of source.matchAll(/uses:\s*(\S+)/g))
      expect(action[1]).toMatch(/@[a-f0-9]{40}$/)
    const workflow = parse(source)
    expect(workflow.permissions.contents).toBe('read')
    expect(workflow.permissions.packages).toBe(file === 'release.yml' ? 'write' : undefined)
  }
  const release = read('.github/workflows/release.yml')
  expect(release).toContain('linux/amd64,linux/arm64')
  expect(release).toContain('ghcr.io/dudaanton/abele-sync')
})

it('licenses all workspace manifests and excludes machine-local deployment configuration', () => {
  for (const file of [
    'package.json',
    ...['cli', 'core', 'protocol', 'server'].map((p) => `packages/${p}/package.json`),
  ]) {
    expect(JSON.parse(read(file)).license).toBe('GPL-3.0-only')
  }
  expect(read('LICENSE')).toContain('Version 3, 29 June 2007')
  for (const file of ['.gitignore', '.dockerignore']) {
    expect(read(file)).toContain('.env')
    expect(read(file)).toContain('.llm')
  }
})
