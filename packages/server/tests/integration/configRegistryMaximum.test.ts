import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'
import {
  isConfigurationPath,
  registeredConfigurationDirectories,
} from '../../src/configurationDirectories.js'
import { createUser } from '../../src/access/tokens.js'
import { v2Server } from '../helpers/v2Server.js'
import { V2SyncClient } from '../helpers/v2SyncClient.js'
import { hasPgTestDb } from '../helpers/tempDb.js'

const extra = Array.from({ length: 16 }, (_, i) => `Config-${i}`)
const env = {
  ABELE_MASTER_KEY: 'ab'.repeat(32),
  ABELE_TOKEN_PEPPER: 'test',
  ABELE_CONFIGURATION_DIRS: JSON.stringify(extra),
}
for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(
    `maximum configuration registry (${dialect})`,
    () => {
      it('keeps root commits working with all registered directories; partial tokens cannot see or write configuration content', async () => {
        const config = loadConfig(env)
        expect(config.configurationDirectories).toHaveLength(17)
        const server = await v2Server(dialect, {
          configurationDirectories: config.configurationDirectories,
        })
        try {
          const token = await createUser(
            { db: server.db, pepper: server.config.tokenPepper, dialect },
            'Owner',
            server.address
          )
          const owner = new V2SyncClient(token.token)
          const result = await owner.create('Agents/note.md', 'note')
          expect(result.status).toBe('applied')
          for (const root of ['.obsidian', ...extra]) {
            expect(isConfigurationPath(`${root}/app.json`, config.configurationDirectories)).toBe(
              true
            )
            const file = await owner.create(`${root}/app.json`, '{}')
            expect(file.status).toBe('applied')
            const dir = (await owner.manifest()).items.find((i) => i.path === root)!
            const guest = new V2SyncClient((await owner.share(dir.file_id)).token)
            expect((await guest.manifest()).items).toEqual([])
            expect((await guest.create(`${root}/private.json`, 'no')).status).toBe('rejected')
            if (file.status !== 'rejected')
              await expect(guest.content(file.file_id)).rejects.toMatchObject({ status: 404 })
          }
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
          await server.close()
        }
      })
    }
  )
