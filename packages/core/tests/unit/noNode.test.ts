import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The two packages the plugin embeds: neither may lean on Node. */
const PACKAGES = {
  core: fileURLToPath(new URL('../../src', import.meta.url)),
  protocol: fileURLToPath(new URL('../../../protocol/src', import.meta.url)),
}

const HOST_ONLY = ['fs', 'path', 'crypto', 'os', 'stream', 'ws', 'child_process']

// Anything platform-specific belongs in a host package (cli, plugin), never in core.
// Catches `from 'x'`, `import 'x'` and `import('x')`, for both `node:fs` and bare `fs`,
// with or without a subpath. This test may use node: itself — it lives in tests/.
const FORBIDDEN_IMPORT = new RegExp(
  `(?:from|import)\\s*\\(?\\s*['"](?:node:[^'"]+|(?:${HOST_ONLY.join('|')})(?:/[^'"]+)?)['"]`
)

/**
 * The globals Node hands out and a browser does not. Matched as identifiers: not after a
 * dot (`this.process`), not inside a longer name, and only once comments are gone, since
 * the prose in these packages says "process" often enough.
 */
const FORBIDDEN_GLOBAL = /(?<![\w$.])(Buffer|process|require|__dirname)(?![\w$])/

/** The source without its comments, so what is flagged is code and not a remark about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

for (const [name, src] of Object.entries(PACKAGES)) {
  describe(`${name} stays platform-neutral`, () => {
    it('has sources to check', () => {
      expect(sourceFiles(src).length).toBeGreaterThan(0)
    })

    it('imports nothing from the Node standard library', () => {
      const offenders = sourceFiles(src).filter((file) =>
        FORBIDDEN_IMPORT.test(readFileSync(file, 'utf8'))
      )
      expect(offenders.map((file) => file.slice(src.length + 1))).toEqual([])
    })

    it('reaches for none of the Node globals', () => {
      const offenders = sourceFiles(src).flatMap((file) => {
        const hit = FORBIDDEN_GLOBAL.exec(withoutComments(readFileSync(file, 'utf8')))
        return hit === null ? [] : [`${file.slice(src.length + 1)}: ${hit[1]}`]
      })
      expect(offenders).toEqual([])
    })
  })
}
