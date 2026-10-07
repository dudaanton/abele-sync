import { createDb } from '../../dist/db/connect.js'
import { updateFolderKey, updateFolderGrant } from '../../dist/auth/folderManagement.js'
process.once('message', async (input) => {
  const handle = createDb(input.url)
  try {
    process.send({ started: true })
    const bound = {
      db: handle.db,
      dialect: 'pg',
      pepper: 'test',
      accountTokenTtlMs: 3600000,
      now: () => new Date(input.at),
    }
    if (input.target === 'grant')
      await updateFolderGrant(bound, input.owner, input.vault, input.grant, {
        expected_revision: 0,
        revoke: true,
      })
    else
      await updateFolderKey(
        {
          db: handle.db,
          dialect: 'pg',
          pepper: 'test',
          accountTokenTtlMs: 3600000,
          now: () => new Date(input.at),
        },
        input.owner,
        input.vault,
        input.grant,
        input.key,
        { expected_revision: 0, revoke: true }
      )
    process.send({ done: true })
  } catch (error) {
    process.send({ error: error.code ?? 'worker_failed' })
  } finally {
    await handle.close()
    process.disconnect()
  }
})
