import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

/**
 * The engine tier mirrors the simulated tier test for test: every simulated scenario
 * is here under the same name, in the same file, so a diff of the two is empty.
 * What the engine alone has to answer for — the size cap, paths off the wire, a server
 * that lies about its bytes — lives under `integration` and `unit`, and is not mirrored.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const simulated = fileURLToPath(new URL('../../../server/tests/scenario/', import.meta.url))

/** Every `it('…')` title in a file, in code-unit order. */
function titlesOf(dir: string, file: string): string[] {
  const source = readFileSync(`${dir}${file}`, 'utf8')
  return [...source.matchAll(/\bit\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? '').sort()
}

describe('parity with the simulated tier', () => {
  const files = readdirSync(simulated).filter((f) => f.endsWith('.test.ts'))

  it('covers the same five files', () => {
    expect(files.sort()).toEqual([
      'concurrency.test.ts',
      'conflicts.test.ts',
      'firstSync.test.ts',
      'staleBase.test.ts',
      'twoDevices.test.ts',
    ])
  })

  it.each(files)('%s has the same test titles in both tiers', (file) => {
    const theirs = titlesOf(simulated, file)
    expect(theirs.length).toBeGreaterThan(0)
    expect(titlesOf(here, file)).toEqual(theirs)
  })
})
