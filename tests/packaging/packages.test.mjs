import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
for (const name of ['protocol', 'core']) {
  test(`${name} is publishable`, () => {
    const p = JSON.parse(readFileSync(`packages/${name}/package.json`))
    assert.notEqual(p.private, true)
    assert.equal(p.version, '0.3.3')
    assert.equal(p.types, './dist/index.d.ts')
    assert.equal(p.license, 'GPL-3.0-only')
    assert.ok(existsSync(`packages/${name}/LICENSE`))
  })
}
