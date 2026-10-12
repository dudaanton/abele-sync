/** Independent-process SQLite snapshot and real SIGKILL regression fixture. */
import { createDb } from '../../dist/db/connect.js'
import { BlobStore } from '../../dist/blobs/store.js'
import { commitChosen } from '../../dist/oplog/commit.js'
import { EventHub } from '../../dist/events/hub.js'

const [database, blobs, vault, actorId, input, mode] = process.argv.slice(2)
const handle = createDb(database)
const store = new BlobStore(blobs, Buffer.from('ab'.repeat(32), 'hex'))
const barrier = async (phase) => {
  process.send({ phase })
  await new Promise((resolve) => process.once('message', resolve))
}
let stopped = false
let retries = 0
const marked = new Set()
const db =
  mode === 'before-commit' || mode === 'race-hold'
    ? handle.db.withPlugin({
        transformQuery({ node, queryId }) {
          if (
            node.kind === 'InsertQueryNode' &&
            node.into?.table?.identifier?.name === 'conflict_divergences'
          )
            marked.add(queryId)
          return node
        },
        async transformResult({ result, queryId }) {
          if (marked.delete(queryId)) await barrier('rows-written')
          return result
        },
      })
    : handle.db
try {
  const response = await commitChosen(
    {
      db,
      dialect: 'sqlite',
      store,
      hub: new EventHub(),
      keyed: {
        actorId,
        key: 'request',
        hash: input,
        ttlMs: 86400000,
        filed: false,
        answer: (r) => r,
      },
    },
    vault,
    { kind: 'device', id: actorId, name: actorId },
    async () => {
      if (mode.startsWith('race') && !stopped) {
        stopped = true
        await barrier('snapshot')
      } else if (mode === 'race-retry' && ++retries === 6) {
        // Keep the other process's write lock held past the old five-retry limit.
        // IPC, rather than a sleep, decides when the writer may finish.
        await barrier('retry-budget')
      }
      return [JSON.parse(input)]
    }
  )
  if (mode === 'after-commit') await barrier('committed')
  process.send({ response })
} catch (error) {
  process.send({ error: String(error), code: error?.code, stack: error?.stack })
  process.exitCode = 1
} finally {
  await handle.close()
  process.disconnect()
}
