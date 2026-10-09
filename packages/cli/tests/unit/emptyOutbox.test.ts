import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { selectiveDefaults } from '@abele/sync-core'
import { writeConfig, stateFolder } from '../../src/config.js'
import { assertLocalSafety } from '../../src/externalSafety.js'

it('BUG: empty scoped staging directories are not retained bytes, while real files remain a retirement hold', async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'empty-outbox-'))
  try {
    writeConfig(dir, {
      serverUrl: 'https://synthetic.example.test',
      vaultId: 'vault',
      deviceId: 'device',
      deviceToken: 'absd_synthetic',
      deviceName: 'test',
      selective: selectiveDefaults(),
    })
    const folder = join(stateFolder(dir), 'scoped-outbox', 'completed', 'empty')
    await mkdir(folder, { recursive: true })
    expect(() => assertLocalSafety(dir, true)).not.toThrow()
    await writeFile(join(folder, 'retained'), 'keep')
    expect(() => assertLocalSafety(dir, true)).toThrowError(
      expect.objectContaining({ reason: 'recovery-required' })
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
