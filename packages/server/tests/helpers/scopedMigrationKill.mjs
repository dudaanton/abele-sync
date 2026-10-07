import { createDb } from '../../dist/db/connect.js'
import { runMigrations } from '../../dist/db/migrate.js'

const [url, target, boundary] = process.argv.slice(2)
const handle = createDb(url)
let cut = false
const plugin = {
  transformQuery({ node }) {
    cut =
      boundary === 'journal'
        ? node.kind === 'InsertQueryNode' && JSON.stringify(node).includes('kysely_migration')
        : node.kind === 'RawNode' && node.sqlFragments.join('').includes(boundary)
    return node
  },
  async transformResult({ result }) {
    if (cut) process.kill(process.pid, 'SIGKILL')
    return result
  },
}
try {
  await runMigrations(handle.db.withPlugin(plugin), undefined, target)
  // A missed boundary must fail the parent assertion, not count as crash evidence.
  process.exitCode = 4
} finally {
  await handle.close()
}
