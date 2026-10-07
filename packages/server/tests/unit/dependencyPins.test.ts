import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
const root = new URL('../../../../', import.meta.url)
it('retains only the audited security versions throughout the resolved URI/test/server graph', () => {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
  expect(lock.packages['node_modules/fastify'].version).toBe('5.12.5')
  expect(lock.packages['node_modules/vitest'].version).toBe('5.0.2')
  expect(lock.packages['node_modules/@vitest/mocker'].version).toBe('5.0.2')
  const uri = Object.entries(lock.packages).filter(([path]) => path.endsWith('/fast-uri'))
  expect(uri.length).toBeGreaterThan(0)
  for (const [_path, value] of uri)
    expect(['3.1.8', '4.2.1']).toContain((value as { version: string }).version)
})
it('uses exact resolved versions for every third-party workspace manifest declaration', () => {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'))
  for (const file of [
    'package.json',
    'packages/cli/package.json',
    'packages/core/package.json',
    'packages/protocol/package.json',
    'packages/server/package.json',
  ]) {
    const pkg = JSON.parse(readFileSync(new URL(file, root), 'utf8')),
      folder = file.replace(/\/?package.json$/, '')
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, version] of Object.entries(pkg[section] ?? {})) {
        expect(version, `${file} ${name}`).not.toMatch(/^[~^]/)
        if (String(name).startsWith('@abele/')) continue
        const resolved =
          lock.packages[`${folder ? folder + '/' : ''}node_modules/${name}`]?.version ??
          lock.packages[`node_modules/${name}`]?.version
        expect(version, `${file} ${name}`).toBe(resolved)
      }
  }
})
