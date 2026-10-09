import { describe, expect, it } from 'vitest'
import type { ChangeItem } from '@abele/sync-protocol'
import { PendingPullWrites } from '../../src/pullWrite.js'
import { MemoryStateStore, type StateEntry } from '../../src/state.js'

const base: StateEntry = {
  path: 'note.md',
  wirePath: 'note.md',
  fileId: 'file',
  versionId: 'base',
  sha: 'base-sha',
  size: 2,
  mtime: 1,
}
const change: ChangeItem = {
  file_id: 'file',
  version_id: 'pulled',
  path: 'note.md',
  prev_path: null,
  sha: 'pulled-sha',
  size: 2,
  mtime: 2,
  seq: 2,
  op: 'modify',
  kind: 'note',
  actor: { kind: 'device', id: 'remote', name: 'remote' },
  at: '',
}

describe('pending pull write authority', () => {
  it('records the preparing host claim and does not retroactively reattribute an existing intent', async () => {
    let owner = 'original-claim'
    const state = Object.assign(new MemoryStateStore(), { effectOwner: () => owner })
    const writes = new PendingPullWrites(state)
    await writes.prepare(change, base, 'note.md', null)
    owner = 'successor-claim'
    expect(JSON.parse((await state.getMeta('pull-write:file'))!).owner).toBe('original-claim')
    expect(await writes.matching(change, base)).not.toBeNull()
  })
  it('matches only the exact recorded version, even when another version has identical bytes', async () => {
    const writes = new PendingPullWrites(new MemoryStateStore())
    await writes.prepare(change, base, 'note.md', null)
    expect(await writes.matching(change, base)).not.toBeNull()
    expect(await writes.matching({ ...change, version_id: 'another-version' }, base)).toBeNull()
    expect(await writes.matching({ ...change, path: 'moved.md' }, base)).toBeNull()
    expect(await writes.matching({ ...change, sha: 'other-bytes' }, base)).toBeNull()
  })

  it('cannot reuse an intent after the pre-write ledger entry changes', async () => {
    const writes = new PendingPullWrites(new MemoryStateStore())
    await writes.prepare(change, base, 'note.md', null)
    expect(await writes.matching(change, null)).toBeNull()
    expect(await writes.matching(change, { ...base, versionId: 'new-baseline' })).toBeNull()
    expect(await writes.matching(change, { ...base, mtime: 3 })).toBeNull()
  })

  it('does not recover when the host cannot persist metadata', async () => {
    const state = new MemoryStateStore()
    Object.defineProperty(state, 'getMeta', { value: undefined })
    Object.defineProperty(state, 'setMeta', { value: undefined })
    const writes = new PendingPullWrites(state)
    await writes.prepare(change, base, 'note.md', null)
    expect(await writes.matching(change, base)).toBeNull()
  })

  it('keeps a future intent while skipping an older already-recorded feed version', async () => {
    const state = new MemoryStateStore()
    const writes = new PendingPullWrites(state)
    await writes.prepare(change, base, 'note.md', null)
    await writes.settled({ ...change, version_id: base.versionId })
    expect(await writes.matching(change, base)).not.toBeNull()
    await writes.settled(change)
    expect(await writes.matching(change, base)).toBeNull()
  })
})
