import { test } from 'node:test'
import assert from 'node:assert/strict'

test('Node adapters are available independently of the CLI', async () => {
  const node = await import('@abele/sync-node')
  for (const name of [
    'NodeFileSystem',
    'SqliteStateStore',
    'SettlingFileSystem',
    'acquireLock',
    'EffectFence',
  ]) {
    assert.equal(typeof node[name], 'function', name)
  }
})
