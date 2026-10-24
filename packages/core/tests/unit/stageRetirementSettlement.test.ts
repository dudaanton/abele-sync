import { expect, it, vi } from 'vitest'
import {
  MemoryFileSystem,
  MemoryStateStore,
  StagedChanges,
  ExpectedWrites,
  sha256,
} from '../../src/index.js'
import { PullPlacer } from '../../src/pullPlace.js'
import { PendingPullWrites } from '../../src/pullWrite.js'
import { change } from './holdFixture.js'
import { decorateStateTransactions } from '../helpers/stateTransactions.js'
import { recoverPendingPullWrites } from '../../src/pullRecovery.js'

it.each([false, true])(
  'batches published cleanup after commit or reload without enumeration (noAck=%s)',
  async (noAck) => {
    const f = await fixture()
    Object.defineProperty(f.state, 'metadataKeys', { value: undefined })
    if (noAck)
      decorateStateTransactions(f.state, (tx) => {
        tx.afterCommit = undefined
      })
    await f.state.transaction(async (tx) => {
      await f.pending.publishCleanup(tx, f.item)
      expect(await tx.getMeta!(f.key)).toBeNull()
      await new PendingPullWrites(tx, f.fs).settled(f.item)
      expect(f.discard).not.toHaveBeenCalled()
    })
    expect(await f.state.getMeta(f.key)).toBeNull()
    expect(await f.state.getMeta('pull-cleanup-head')).not.toBeNull()
    if (!noAck) {
      await f.pending.settled(f.item)
      expect(f.discard).toHaveBeenCalledExactlyOnceWith('old-stage')
      await f.pending.flushCleanup()
    } else {
      await f.pending.settled(f.item)
      expect(f.discard).not.toHaveBeenCalled()
      // The old file identity need not remain in the ledger to find its cleanup.
      await recoverPendingPullWrites(f.fs, f.state, [])
      expect(f.discard).toHaveBeenCalledExactlyOnceWith('old-stage')
    }
    expect(await f.state.getMeta('pull-cleanup-head')).toBeNull()
  }
)

it('rolls back published cleanup ownership without discarding the installation evidence', async () => {
  const f = await fixture()
  await expect(
    f.state.transaction(async (tx) => {
      await f.pending.publishCleanup(tx, f.item)
      throw new Error('rollback')
    })
  ).rejects.toThrow('rollback')
  expect(await f.state.getMeta(f.key)).toBe(f.original)
  expect(await f.state.getMeta('pull-cleanup-head')).toBeNull()
  expect(f.discard).not.toHaveBeenCalled()
})

it('replays interrupted published cleanup without installing or losing its owner', async () => {
  const f = await fixture()
  await f.state.transaction((tx) => f.pending.publishCleanup(tx, f.item))
  const owner = await f.state.getMeta('pull-cleanup-head')
  f.discard.mockRejectedValueOnce(new Error('cleanup interrupted'))
  await expect(f.pending.settled(f.item)).rejects.toThrow('cleanup interrupted')
  expect(await f.state.getMeta('pull-cleanup-head')).toBe(owner)
  await recoverPendingPullWrites(f.fs, f.state, [])
  expect(f.discard).toHaveBeenCalledTimes(2)
  expect(await f.state.getMeta('pull-cleanup-head')).toBeNull()
  expect(await f.state.getMeta(owner!)).toBeNull()
  expect(await f.fs.stat(f.item.path)).toBeNull()
})

it('reloads committed retirement without afterCommit and preserves raw outer rollback', async () => {
  const f = await fixture()
  decorateStateTransactions(f.state, (tx) => {
    tx.afterCommit = undefined
  })
  await expect(
    f.state.transaction(async (tx) => {
      await new PendingPullWrites(tx, f.fs).settled(f.item)
      throw new Error('rollback')
    })
  ).rejects.toThrow('rollback')
  expect(f.discard).not.toHaveBeenCalled()
  expect(await f.state.getMeta(f.key)).toBe(f.original)
  await f.pending.settled(f.item)
  expect(f.discard).not.toHaveBeenCalled()
  expect(JSON.parse((await f.state.getMeta(f.key))!).retiring).toBe(true)
  await recoverPendingPullWrites(f.fs, f.state, [f.item.file_id])
  expect(f.discard).toHaveBeenCalledExactlyOnceWith('old-stage')
  expect(await f.state.getMeta(f.key)).toBeNull()
})

it('keeps installation receipt evidence through raw outer rollback of successful cleanup', async () => {
  const f = await fixture()
  const discardInstallation = vi.fn(async (_id: string) => {})
  const fs = Object.assign(f.fs, { discardInstallation })
  await f.pending.prepare(f.item, null, f.item.path, null, 'old-stage', 'old-receipt')
  const original = await f.state.getMeta(f.key)
  await expect(
    f.state.transaction(async (outer) => {
      const placer = new PullPlacer(
        {
          getBlob: async () => {
            throw new Error('cleanup must not download')
          },
        },
        fs,
        outer,
        {
          dirty: new Set(),
          expected: new ExpectedWrites(),
          filter: { excluded: () => false },
        },
        sha256
      )
      await placer.settled(f.item)
      throw new Error('outer rollback')
    })
  ).rejects.toThrow('outer rollback')
  expect(discardInstallation).not.toHaveBeenCalled()
  expect(f.discard).not.toHaveBeenCalled()
  expect(await f.state.getMeta(f.key)).toBe(original)
})

it('does not discard a successfully installed stage before its owning outer commit', async () => {
  const f = await fixture()
  await expect(
    f.state.transaction(async (outer) => {
      await new PendingPullWrites(outer, f.fs).settled(f.item, f.discard)
      throw new Error('outer rollback')
    })
  ).rejects.toThrow('outer rollback')
  expect(f.discard).not.toHaveBeenCalled()
  expect(await f.state.getMeta(f.key)).toBe(f.original)
})

it('does not acknowledge publication retention when live adoption rolls back', async () => {
  const f = await fixture()
  await f.fs.conditionalFile({
    path: f.item.path,
    expected: null,
    effect: { kind: 'write', bytes: new Uint8Array([1]), mtime: 1, receipt: 'old-receipt' },
  })
  await f.pending.prepare(f.item, null, f.item.path, null, 'old-stage', 'old-receipt')
  const discard = vi.spyOn(f.fs, 'discardInstallation')
  const original = await f.state.getMeta(f.key)
  await expect(
    f.state.transaction(async (tx) => {
      const placer = new PullPlacer(
        { getBlob: async () => new Uint8Array([1]) },
        f.fs,
        tx,
        { dirty: new Set(), expected: new ExpectedWrites(), filter: { excluded: () => false } },
        sha256
      )
      expect(await placer.adopt(f.item, null)).toBe(true)
      throw new Error('outer rollback')
    })
  ).rejects.toThrow('outer rollback')
  expect(f.discard).not.toHaveBeenCalled()
  expect(discard).not.toHaveBeenCalled()
  expect(await f.state.getMeta(f.key)).toBe(original)
})

it('keeps a replacement intent arriving during successful stage cleanup', async () => {
  const f = await fixture()
  const replacement = JSON.stringify({
    ...JSON.parse(f.original),
    versionId: 'newer',
    stageId: 'new-stage',
  })
  f.discard.mockImplementation(async () => {
    await f.state.setMeta(f.key, replacement)
  })
  await f.pending.settled(f.item, f.discard)
  expect(await f.state.getMeta(f.key)).toBe(replacement)
})

it('publishes successful cleanup ownership with the frontier before discarding bytes', async () => {
  const f = await fixture()
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = (work) =>
    transaction(async (tx) => {
      tx.setCursor = async () => {
        throw new Error('frontier failed')
      }
      return work(tx)
    })
  await expect(f.pending.settled(f.item, f.discard)).rejects.toThrow('frontier failed')
  expect(await f.state.getMeta(f.key)).toBe(f.original)
  expect(f.discard).not.toHaveBeenCalled()
})

async function fixture() {
  const state = new MemoryStateStore()
  const discard = vi.fn(async (_id: string) => {})
  const fs = Object.assign(new MemoryFileSystem(), {
    discardStage: discard as (id: string) => Promise<void>,
  })
  const item = await change(0)
  const pending = new PendingPullWrites(state, fs)
  await new StagedChanges(state, fs).stage([{ change: item, base: null }])
  await pending.prepare(item, null, item.path, null, 'old-stage')
  await state.setCursor(1)
  const key = `pull-write:${item.file_id}`
  const original = (await state.getMeta(key))!
  return { state, fs, discard, item, pending, key, original }
}

it('rolls decision and retirement marker back with the frontier before discarding bytes', async () => {
  const f = await fixture()
  const decisions = await f.state.getMeta('deferred-changes')
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = (work) =>
    transaction(async (tx) => {
      tx.setCursor = async () => {
        throw new Error('frontier failed')
      }
      return work(tx)
    })
  await expect(f.pending.retireDecision(f.item)).rejects.toThrow('frontier failed')
  expect(await f.state.getMeta(f.key)).toBe(f.original)
  expect(await f.state.getMeta('deferred-changes')).toBe(decisions)
  expect(f.discard).not.toHaveBeenCalled()
})

it.each(['add', 'drop'] as const)(
  'does not overwrite a newer decision document during %s',
  async (mode) => {
    const f = await fixture()
    const newer = JSON.stringify({
      staged: [{ change: { ...f.item, version_id: 'newer' }, base: null }],
    })
    const get = f.state.getMeta.bind(f.state)
    let replaced = false
    f.state.getMeta = async (key) => {
      const result = await get(key)
      if (key === 'deferred-changes' && !replaced) {
        replaced = true
        await f.state.setMeta(key, newer)
      }
      return result
    }
    const staged = new StagedChanges(f.state, f.fs)
    await expect(
      mode === 'drop'
        ? staged.drop([f.item.file_id])
        : staged.stage([{ change: { ...f.item, file_id: 'other', path: 'other.md' }, base: null }])
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await get('deferred-changes')).toBe(newer)
    expect(await get(f.key)).toBe(f.original)
    expect(f.discard).not.toHaveBeenCalled()
  }
)

it('binds concurrent decision writers to their own observed revision', async () => {
  const f = await fixture()
  const newer = JSON.stringify({
    staged: [{ change: { ...f.item, version_id: 'newer' }, base: null }],
  })
  const get = f.state.getMeta.bind(f.state)
  const older = await get('deferred-changes')
  await f.state.setMeta('deferred-changes', newer)
  let reads = 0
  f.state.getMeta = async (key) => {
    if (key === 'deferred-changes' && reads < 2) return ++reads === 1 ? older : newer
    return get(key)
  }
  const staged = new StagedChanges(f.state, f.fs)
  const results = await Promise.allSettled(
    ['a', 'b'].map((id) =>
      staged.stage([{ change: { ...f.item, file_id: id, path: `${id}.md` }, base: null }])
    )
  )
  expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
  const rows = JSON.parse((await get('deferred-changes'))!).staged
  expect(
    rows.find((row: { change: { file_id: string } }) => row.change.file_id === f.item.file_id)
      .change.version_id
  ).toBe('newer')
})

it('does not discard bytes before a raw outer transaction commits its retirement', async () => {
  const f = await fixture()
  await expect(
    f.state.transaction(async (outer) => {
      await new PendingPullWrites(outer, f.fs).retireDecision(f.item)
      throw new Error('outer rollback')
    })
  ).rejects.toThrow('outer rollback')
  expect(f.discard).not.toHaveBeenCalled()
  expect(await f.state.getMeta(f.key)).toBe(f.original)
  expect(await new StagedChanges(f.state, f.fs).count()).toBe(1)
  await f.state.transaction(async (outer) => {
    await new PendingPullWrites(outer, f.fs).retireDecision(f.item)
    expect(f.discard).not.toHaveBeenCalled()
  })
  await new PendingPullWrites(f.state, f.fs).finishRetirement(f.item)
  expect(f.discard.mock.calls).toEqual([['old-stage']])
  expect(await f.state.getMeta(f.key)).toBeNull()
})

it('preserves a replacement intent installed while old private bytes are discarded', async () => {
  const f = await fixture()
  const replacement = JSON.stringify({
    ...JSON.parse(f.original),
    versionId: 'new',
    stageId: 'new-stage',
  })
  f.fs.discardStage = async (id) => {
    f.discard(id)
    await f.state.setMeta(f.key, replacement)
  }
  await f.pending.retireDecision(f.item)
  expect(await f.state.getMeta(f.key)).toBe(replacement)
  expect(f.discard.mock.calls).toEqual([['old-stage']])
})

it('preserves replacement ownership before retirement publication without discarding its resources', async () => {
  const f = await fixture()
  const retiring = JSON.stringify({ ...JSON.parse(f.original), retiring: true })
  await f.state.setMeta(f.key, retiring)
  const replacement = JSON.stringify({
    ...JSON.parse(f.original),
    versionId: 'new',
    stageId: 'new-stage',
  })
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = async (work) => {
    await f.state.setMeta(f.key, replacement)
    return transaction(work)
  }
  await f.pending.finishRetirement(f.item)
  expect(await f.state.getMeta(f.key)).toBe(replacement)
  expect(f.discard).not.toHaveBeenCalled()
})

it('keeps the retirement marker after cleanup publication rolls back and can retry cleanup', async () => {
  const f = await fixture()
  const transaction = f.state.transaction.bind(f.state)
  f.state.transaction = (work) =>
    transaction(async (tx) => {
      const cursor = tx.setCursor.bind(tx)
      tx.setCursor = async (value) => {
        if ((await tx.getMeta!(f.key)) === null) throw new Error('cleanup frontier failed')
        await cursor(value)
      }
      return work(tx)
    })
  await expect(f.pending.retireDecision(f.item)).rejects.toThrow('cleanup frontier failed')
  expect(JSON.parse((await f.state.getMeta(f.key))!)).toMatchObject({
    retiring: true,
    stageId: 'old-stage',
  })
  expect(await f.state.getMeta('deferred-changes')).toBeNull()
  expect(f.discard.mock.calls).toEqual([['old-stage']])
  f.state.transaction = transaction
  await new PendingPullWrites(f.state, f.fs).finishRetirement(f.item)
  expect(await f.state.getMeta(f.key)).toBeNull()
  expect(f.discard.mock.calls).toEqual([['old-stage'], ['old-stage']])
})

it('retires one owned stage with bounded persistence among 33k unrelated intents', async () => {
  const f = await fixture()
  for (let n = 0; n < 33000; n++)
    await f.state.setMeta(
      `pull-write:other-${n}`,
      JSON.stringify({ fileId: `other-${n}`, stageId: `stage-${n}` })
    )
  await f.state.setMeta(f.key, JSON.stringify({ ...JSON.parse(f.original), retiring: true }))
  let reads = 0,
    writes = 0,
    bytes = 0
  decorateStateTransactions(f.state, (tx) => {
    const get = tx.getMeta!.bind(tx),
      set = tx.setMeta!.bind(tx)
    tx.getMeta = async (key) => {
      reads++
      return get(key)
    }
    tx.setMeta = async (key, value) => {
      writes++
      bytes += key.length + (value?.length ?? 0)
      await set(key, value)
    }
    tx.metadataKeys = () => {
      throw new Error('unbounded retirement enumeration')
    }
  })
  await f.pending.finishRetirement(f.item)
  expect(await f.state.getMeta(f.key)).toBeNull()
  expect(reads).toBeLessThanOrEqual(20)
  expect(writes).toBeLessThanOrEqual(2)
  expect(bytes).toBeLessThanOrEqual(2048)
  expect(f.discard.mock.calls).toEqual([['old-stage']])
})
