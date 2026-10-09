/** Production daemon adapters in a separate process, stopped at an acknowledged cut point. */
import { prepareVault, recoverVault, buildEngine, rememberVault } from '../../../dist/vault.js'
import { acquireLock } from '../../../dist/lock.js'
const [dir, cut] = process.argv.slice(2)
if (cut === 'init-config') {
  const { runInit } = await import('../../../dist/commands/init.js')
  await runInit(
    {
      dir,
      server: process.env.ABELE_TEST_SERVER,
      email: 'pair@example.com',
      vault: process.env.ABELE_TEST_NEXT_VAULT,
      force: true,
      prefer: 'merge',
    },
    {
      env: { ABELE_PASSWORD: 'correct horse battery staple' },
      fetch: globalThis.fetch,
      io: {
        err() {},
        out(line) {
          if (line.startsWith('wrote ')) {
            process.send({ barrier: cut })
            // Synchronous cut: runInit must not reach settleState after config rename.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
          }
        },
      },
      revokeTimeoutMs: 1000,
    }
  )
  throw new Error('init cut was not reached')
}
const ctx = {
  io: { out() {}, err() {} },
  env: {},
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  revokeTimeoutMs: 1000,
}
const release = await acquireLock(dir)
const vault = await prepareVault(dir, ctx, release.held)
await recoverVault(vault, release.held)
rememberVault(vault)
let tripped = false
const barrier = async () => {
  if (tripped) return
  tripped = true
  process.send({ barrier: cut })
  await new Promise(() => {})
}
function wrap(object, method, where) {
  const original = object[method].bind(object)
  object[method] = async (...args) => {
    if (where === 'before') await barrier()
    const result = await original(...args)
    if (where === 'after') await barrier()
    return result
  }
}
if (cut === 'scan') wrap(vault.fs, 'read', 'after')
if (cut === 'upload') wrap(vault.client, 'putBlob', 'after')
if (cut === 'commit-before') wrap(vault.client, 'commitRaw', 'before')
if (cut === 'commit-after') wrap(vault.client, 'commitRaw', 'after')
if (cut === 'record' || cut === 'pull-ledger') wrap(vault.state, 'put', 'after')
if (cut === 'pull-write') wrap(vault.fs, 'writeAtomic', 'after')
if (cut === 'pull-cursor') wrap(vault.state, 'setCursor', 'after')
if (cut === 'merge-download') wrap(vault.client, 'getBlob', 'after')
if (cut === 'delete-tally') {
  const transaction = vault.state.transaction.bind(vault.state)
  vault.state.transaction = async (fn) => {
    const before = await vault.state.getJournal()
    const answer = await transaction(fn)
    if (before !== null && (await vault.state.getJournal()) === null) await barrier()
    return answer
  }
}
if (cut === 'join-marker' || cut === 'held-decision') {
  const set = vault.state.setMeta.bind(vault.state)
  vault.state.setMeta = (key, value) => {
    set(key, value)
    if (
      (cut === 'join-marker' && key === 'join-open' && value !== null) ||
      (cut === 'held-decision' && key === 'delete-decision' && value === null)
    ) {
      process.send({ barrier: cut })
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
  }
}
const engine = buildEngine(vault, { fallbackMs: 300000, log() {}, stillHeld: release.held })
try {
  await engine.sync()
  throw new Error(`cut point was not reached: ${cut}`)
} catch (error) {
  process.send({ error: String(error) })
} finally {
  await engine.stop()
  vault.close()
  release()
  process.disconnect()
}
