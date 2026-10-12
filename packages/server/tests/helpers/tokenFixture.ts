import { createUser } from '../../src/access/tokens.js'
import { v2Server } from './v2Server.js'
import { V2SyncClient } from './v2SyncClient.js'
import type { CommitOpResult } from '@abele/sync-protocol'

export function success(result: CommitOpResult) {
  if (result.status === 'rejected') throw new Error(`${result.code}: ${result.message}`)
  return result
}
export async function tokenFixture(dialect: 'sqlite' | 'pg' = 'sqlite') {
  const t = await v2Server(dialect)
  try {
    const issued = await createUser({ db: t.db, pepper: t.config.tokenPepper }, 'Owner', t.address)
    const root = new V2SyncClient(issued.token)
    const dir = success((await root.commit([{ op: 'mkdir', path: 'Agents' }])).results[0]!)
    const share = await root.share(dir.file_id)
    const guest = new V2SyncClient(share.token)
    return {
      t,
      root,
      guest,
      share,
      space: (await root.json('/connection')).space_id,
      close: () => t.close(),
    }
  } catch (error) {
    await t.close()
    throw error
  }
}
