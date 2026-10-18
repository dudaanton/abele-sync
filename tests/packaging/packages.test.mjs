import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
for (const name of ['protocol', 'core', 'node']) {
  test(`${name} is publishable`, () => {
    const p = JSON.parse(readFileSync(`packages/${name}/package.json`))
    assert.notEqual(p.private, true)
    assert.deepEqual(p.repository, {
      type: 'git',
      url: 'git+https://github.com/dudaanton/abele-sync.git',
      directory: `packages/${name}`,
    })
    assert.equal(p.version, '0.3.3')
    assert.equal(p.types, './dist/index.d.ts')
    assert.equal(p.license, 'GPL-3.0-only')
    assert.ok(existsSync(`packages/${name}/LICENSE`))
  })
  test(`${name} tarball contains repository, exports and license`, () => {
    const dest = mkdtempSync(join(tmpdir(), 'abele-pack-'))
    try {
      const [packed] = JSON.parse(
        execFileSync(
          'npm',
          ['pack', `./packages/${name}`, '--json', '--ignore-scripts', '--pack-destination', dest],
          { encoding: 'utf8' }
        )
      )
      const archive = join(dest, packed.filename)
      const manifest = JSON.parse(
        execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' })
      )
      assert.deepEqual(
        manifest.repository,
        JSON.parse(readFileSync(`packages/${name}/package.json`)).repository
      )
      assert.equal(manifest.license, 'GPL-3.0-only')
      const files = new Set(packed.files.map((file) => file.path))
      assert.ok(files.has('LICENSE'))
      for (const entry of Object.values(manifest.exports['.']))
        assert.ok(files.has(entry.replace(/^\.\//, '')), entry)
      assert.equal(
        execFileSync('tar', ['-xOf', archive, 'package/LICENSE'], { encoding: 'utf8' }),
        readFileSync('LICENSE', 'utf8')
      )
    } finally {
      rmSync(dest, { recursive: true, force: true })
    }
  })
}
