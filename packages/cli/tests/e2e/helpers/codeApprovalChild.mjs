/** A real code approval stopped before its filesystem group or SQLite transaction finishes. */
import { runCli } from '../../../dist/cli.js'
import { NodeFileSystem } from '@abele/sync-node'
import { SqliteStateStore } from '@abele/sync-node'
const [dir, id, fingerprint, cut] = process.argv.slice(2)
const pause = async () => {
  // An unresolved top-level await alone lets Node exit 13; stay alive for a real SIGKILL.
  process.channel?.ref()
  process.send({ barrier: cut })
  await new Promise(() => {})
}
if (cut === 'after-main') {
  const write = NodeFileSystem.prototype.conditionalFile
  NodeFileSystem.prototype.conditionalFile = async function (op) {
    const applied = await write.call(this, op)
    if (applied && this.root === dir && op.path === `.obsidian/plugins/${id}/main.js`) await pause()
    return applied
  }
} else {
  const transaction = SqliteStateStore.prototype.transaction
  SqliteStateStore.prototype.transaction = async function (fn) {
    const outer = this.depth === 0
    return transaction.call(this, async () => {
      const result = await fn()
      if (outer) await pause()
      return result
    })
  }
}
const result = await runCli(
  ['code', '--dir', dir, '--approve', id, '--expect', fingerprint],
  {},
  {
    out() {},
    err(line) {
      process.stderr.write(`${line}\n`)
    },
  }
)
throw new Error(`approval ended without reaching ${cut}: ${result}`)
