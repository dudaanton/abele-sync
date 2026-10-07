import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  configurationPath,
  registeredConfigurationDirectories,
} from '../../src/scoped/folderSecurity.js'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

const extra = Array.from({ length: 16 }, (_, i) => `Config-${i}`)
const env = {
  ABELE_MASTER_KEY: 'ab'.repeat(32),
  ABELE_TOKEN_PEPPER: 'test',
  ABELE_CONFIGURATION_DIRS: JSON.stringify(extra),
}
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `maximum configuration registry (${dialect})`,
    () => {
      it('keeps personal commits working with sixteen extra directories and the built-in .obsidian', async () => {
        const config = loadConfig(env)
        expect(config.configurationDirectories).toHaveLength(17)
        const t = await buildTestApp({
          dialect,
          configurationDirectories: config.configurationDirectories,
        })
        try {
          const owner = await t.account(),
            vault = (await t.vault(owner.accountToken)).vaultId,
            device = await t.device(owner.accountToken, vault)
          await putBlob(t.app, device.deviceToken, 'note')
          const result = (
            await commit(t.app, device.deviceToken, vault, [create('Agents/note.md', 'note')])
          ).results[0]
          expect(result.status).toBe('applied')
          const facts = await t.db
            .selectFrom('version_security_sources')
            .selectAll()
            .where('version_id', '=', result.version_id)
            .executeTakeFirstOrThrow()
          expect(facts).toMatchObject({ executable: 0, settings: 0 })
          for (const root of ['.obsidian', ...extra])
            expect(
              configurationPath(`${root}/app.json`, {
                configurationDirectories: config.configurationDirectories,
              })
            ).toBe(true)
          expect(registeredConfigurationDirectories(config.configurationDirectories)).toEqual(
            config.configurationDirectories
          )
          expect(() =>
            loadConfig({
              ...env,
              ABELE_CONFIGURATION_DIRS: JSON.stringify([...extra, 'Config-16']),
            })
          ).toThrow(/ABELE_CONFIGURATION_DIRS/)
        } finally {
          await t.close()
        }
      })
    }
  )
}
