import { expect, it } from 'vitest'
import { PullHolds } from '../../src/pullHolds.js'
import { transact } from '../../src/stateTransaction.js'
import { commitAppliedSettlement } from '../../src/settlement.js'
import { change } from '../unit/holdFixture.js'
import { DurableStateStore } from './durableState.js'
import { EpochError, SimScheduler } from './scheduler.js'

it('keeps unresolved work, ledger publication and cursor atomic at every commit cut', async () => {
  async function execute(cut?: string, recoveryCut?: string) {
    const scheduler = new SimScheduler(701)
    let state = new DurableStateStore(scheduler)
    let holds = new PullHolds(state)
    await holds.load()
    const item = await change(0)
    holds.put({ change: item, base: null, firstSeq: item.seq })
    await transact(state, async (tx) => {
      await holds.persist(10, true, tx)
      await tx.setCursor(0)
    })
    const settle = async () => {
      holds.resolve(item)
      await commitAppliedSettlement(
        state,
        () => ({ reached: 10, firstUnresolved: holds.earliest() }),
        async (tx) => {
          await tx.put({
            path: item.path,
            wirePath: item.path,
            fileId: item.file_id,
            versionId: item.version_id,
            sha: item.sha!,
            size: item.size!,
            mtime: item.mtime!,
          })
          await holds.persist(10, true, tx)
        }
      )
    }
    const attempt = async (point?: string) => {
      scheduler.cut = point
      try {
        await settle()
      } catch (error) {
        if (!(error instanceof EpochError) || !point) throw error
      }
      scheduler.cut = undefined
    }
    const reopen = async () => {
      state = state.reopen()
      holds = new PullHolds(state)
      await holds.load()
      const cursor = await state.getCursor()
      expect([0, 10]).toContain(cursor)
      expect(holds.files.has(item.file_id)).toBe(cursor === 0)
      expect((await state.byFileId(item.file_id)) !== null).toBe(cursor === 10)
    }
    let start = scheduler.points.length
    await attempt(cut)
    const cuts = scheduler.points.slice(start)
    await reopen()
    start = scheduler.points.length
    await attempt(recoveryCut)
    const recoveryCuts = scheduler.points.slice(start)
    await reopen()
    await attempt()
    await reopen()
    expect(await state.getCursor()).toBe(10)
    expect(holds.dirty).toBe(false)
    return { cuts, recoveryCuts }
  }
  for (const cut of (await execute()).cuts) {
    const { recoveryCuts } = await execute(cut)
    for (const recoveryCut of recoveryCuts) await execute(cut, recoveryCut)
  }
})
