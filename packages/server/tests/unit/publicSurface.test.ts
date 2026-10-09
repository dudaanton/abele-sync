import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

it('ships only deployment and current-state reference documents', () => {
  expect(readdirSync(resolve(root, 'docs')).sort()).toEqual([
    'deploy.md',
    'external-file-cli-state.md',
    'protocol.md',
    'schema.md',
    'security.md',
  ])
})

it('resolves every relative README and documentation link', () => {
  for (const path of [
    'README.md',
    ...readdirSync(resolve(root, 'docs'))
      .filter((name) => name.endsWith('.md'))
      .map((name) => 'docs/' + name),
  ]) {
    for (const match of read(path).matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!.split('#')[0]!
      if (!target || /^[a-z]+:/i.test(target)) continue
      expect(existsSync(resolve(root, dirname(path), target)), `${path}: ${target}`).toBe(true)
    }
  }
})

it('ships one compose example with a digest-pinned PostgreSQL image', () => {
  const files = readdirSync(root).filter((name) => /^(docker-)?compose.*\.ya?ml$/.test(name))
  expect(files).toEqual(['docker-compose.example.yml'])
  const compose = parse(read(files[0]!))
  expect(compose.services.postgres.image).toMatch(/^postgres:16-bookworm@sha256:[a-f0-9]{64}$/)
})

it('keeps only scripts used by package commands or automated tests', () => {
  expect(readdirSync(resolve(root, 'scripts')).sort()).toEqual([
    'query-cost-analysis.d.mts',
    'query-cost-analysis.mjs',
    'test-sql-disposable.sh',
    'test-sql.mjs',
    'upgrade-preflight.mjs',
    'validate-cost-report.d.mts',
    'validate-cost-report.mjs',
  ])
})
