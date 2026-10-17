/** Production daemon adapters in a separate process, stopped at an acknowledged cut point. */
import { prepareVault, recoverVault, buildEngine, rememberVault } from '../../../dist/vault.js'
import { acquireLock } from '@abele/sync-node'
const [dir, cut] = process.argv.slice(2)
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
if (cut === 'scan') wrap(vault.fs, 'fingerprint', 'after')
if (cut === 'upload') wrap(vault.client, 'putBlobSource', 'after')
if (cut === 'upload-read' || cut === 'upload-second-pass') {
  const original = vault.client.putBlobSource.bind(vault.client)
  vault.client.putBlobSource = async (expected, source, ...rest) => {
    const read = source.read.bind(source)
    let passes = 0
    source.read = async (offset, ...args) => {
      const bytes = await read(offset, ...args)
      if (offset === 0) passes++
      if (passes === (cut === 'upload-read' ? 1 : 2)) await barrier()
      return bytes
    }
    return original(expected, source, ...rest)
  }
}
if (cut === 'commit-before') wrap(vault.client, 'commitRaw', 'before')
if (cut === 'commit-after') wrap(vault.client, 'commitRaw', 'after')
if (cut === 'record' || cut === 'pull-ledger') wrap(vault.state, 'put', 'after')
// Stop on durable streaming checkpoints, not the bypassed whole-buffer writer.
if (['pull-append', 'pull-seal', 'pull-write', 'merge-download'].includes(cut)) {
  for (const method of ['beginAtomicWrite', 'reopenStage']) {
    const original = vault.fs[method].bind(vault.fs)
    vault.fs[method] = async (...args) => {
      const stage = await original(...args)
      wrap(
        stage,
        cut === 'pull-write' ? 'commit' : cut === 'pull-append' ? 'append' : 'seal',
        'after'
      )
      return stage
    }
  }
}
if (cut === 'pull-cursor') wrap(vault.state, 'setCursor', 'after')
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
