import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const visited = new Set<string>()
const imported = new Set<string>()
function walk(file: string): void {
  if (visited.has(file)) return
  visited.add(file)
  const facts = ts.preProcessFile(readFileSync(file, 'utf8'), true, true)
  for (const { fileName } of facts.importedFiles) {
    imported.add(fileName)
    const next = fileName.startsWith('.')
      ? resolve(dirname(file), fileName.replace(/\.js$/, '.ts'))
      : fileName === '@abele/sync-protocol'
        ? resolve(root, 'packages/protocol/src/index.ts')
        : fileName === '@abele/sync-core'
          ? resolve(root, 'packages/core/src/index.ts')
          : undefined
    if (next && existsSync(next)) walk(next)
  }
}

it('active server/engine/daemon imports cannot reach parked group/body indexing or broad v3 services', () => {
  // Personal merge may parse YAML for normalization; scope parsing/indexing is the forbidden dependency.
  for (const entry of [
    'server/src/api/app.ts',
    'server/src/oplog/commit.ts',
    'core/src/engine.ts',
    'cli/src/vault.ts',
  ]) {
    walk(resolve(root, 'packages', entry))
  }
  expect(visited.size).toBeGreaterThan(30)
  expect([...imported].filter((name) => name.startsWith('@abele/scope'))).toEqual([])
  const forbidden =
    /\/server\/src\/scope\/|\/(noteLinks|markdownTokens|attachments|referenceIndex|observations|dispositions|atomicUnits|atomicBounds)\.ts$/
  expect([...visited].filter((path) => forbidden.test(path))).toEqual([])
})
