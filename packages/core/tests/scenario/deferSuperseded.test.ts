import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device } from '../helpers/device.js'
import { shaOf } from '../helpers/seed.js'
import { APP, CONFIG, head, pairOf } from '../helpers/deferPair.js'

/**
 * A staged change the file has moved on from: once the entry
 * no longer stands at the version the change was staged against — a pull took a later change as
 * usual, or a push of this device's landed — the record is out of date. It goes at once, and it
 * is never written: writing it would put older bytes over the newer head, and nothing would ever
 * notice, since the entry would then describe the disk.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

/** The engine's staging, to stand in for a process killed between a commit and its afterPush. */
interface WithStaging {
  staging: { afterPush: (...args: unknown[]) => Promise<void> }
}

describe('a staged change the file has moved on from', () => {
  it('goes when a later change is taken in place, even if the push after it never lands', async () => {
    const { a, b, seeder } = await pairOf(h, account, 'defer-revert-offline')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    expect(a.engine.status.deferred).toBe(1)
    // B goes back to what A has: A's pull takes that change in place.
    await b.write(APP, '{"a":1}')
    await b.sync()
    // And A's own commit, of a note, fails: the phone went offline mid-sync.
    await a.write('Note.md', 'edited here\n')
    const commitRaw = a.client.commitRaw
    a.client.commitRaw = async () => {
      a.client.commitRaw = commitRaw
      throw new TypeError('fetch failed')
    }
    await expect(a.sync()).rejects.toThrow('fetch failed')
    expect(await a.engine.deferred()).toEqual([])

    // Reload, then two syncs: the older {"a":2} is never written.
    expect(await a.engine.applyDeferred()).toEqual({ applied: [], skipped: [] })
    await a.sync()
    await a.sync()
    expect(await a.text(APP)).toBe('{"a":1}')
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":1}'))
    await a.assertStateMatchesDisk()
  })

  it('says it was replaced by a later change, not by one made here', async () => {
    const { a, b } = await pairOf(h, account, 'defer-revert-log')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    await b.write(APP, '{"a":1}')
    await b.sync()
    await a.write('Note.md', 'edited here\n')
    const report = await a.sync()

    expect(report.push.committed).not.toBeNull()
    expect(report.deferred).toBe(0)
    const log = a.lines.join('\n')
    expect(log).toContain(`the change to ${APP} from B was replaced by a later one`)
    expect(log).not.toContain('on this device replaced')
  })

  it('is never written after a commit of this device landed and the process died before settling it', async () => {
    const { vaultId, a, b, seeder } = await pairOf(h, account, 'defer-killed')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    // A's own edit, newer: it wins on the server.
    await a.write(APP, '{"a":"here"}')
    ;(a.engine as unknown as WithStaging).staging.afterPush = async () => {
      throw new Error('killed')
    }
    await expect(a.sync()).rejects.toThrow('killed')
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"here"}'))

    const again = new Device(h, vaultId, a.deviceToken, 'A', {
      fs: a.fs,
      state: a.state,
      defer: CONFIG,
    })
    expect(await again.engine.applyDeferred()).toEqual({ applied: [], skipped: [] })
    expect(await again.text(APP)).toBe('{"a":"here"}')
    expect(await again.engine.deferred()).toEqual([])
    await again.sync()
    expect(await again.text(APP)).toBe('{"a":"here"}')
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"here"}'))
    await again.assertStateMatchesDisk()
  })

  it('is not kept over the newer head either', async () => {
    const { vaultId, a, b, seeder } = await pairOf(h, account, 'defer-killed-keep')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    await a.write(APP, '{"a":"here"}')
    ;(a.engine as unknown as WithStaging).staging.afterPush = async () => {
      throw new Error('killed')
    }
    await expect(a.sync()).rejects.toThrow('killed')

    const again = new Device(h, vaultId, a.deviceToken, 'A', {
      fs: a.fs,
      state: a.state,
      defer: CONFIG,
    })
    expect(await again.engine.keepLocal()).toEqual({ kept: [], left: [] })
    const report = await again.sync()
    expect(report.push.committed).toBeNull()
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"here"}'))
  })
})

describe('a staged head whose batch was never recorded', () => {
  it('is not dropped by a Reload before the replay, and the replay does not ask again', async () => {
    const { vaultId, a, b, seeder } = await pairOf(h, account, 'defer-unrecorded')
    await a.write(APP, '{"a":"here, earlier"}')
    await b.write(APP, '{"a":"there, later"}')
    await b.sync()
    // The push stages B's head, and the process dies before the batch's results are recorded.
    const transaction = a.state.transaction
    a.state.transaction = async () => {
      throw new Error('killed')
    }
    await expect(a.sync()).rejects.toThrow('killed')
    a.state.transaction = transaction
    expect(await a.state.getJournal()).not.toBeNull()

    const again = new Device(h, vaultId, a.deviceToken, 'A', {
      fs: a.fs,
      state: a.state,
      defer: CONFIG,
    })
    // Reload before any sync: the record stands, and nothing says it was replaced.
    await again.engine.applyDeferred()
    expect((await again.engine.deferred()).map((one) => one.path)).toEqual([APP])
    expect(again.lines.join('\n')).not.toContain('was replaced by a later one')
    expect(await again.text(APP)).toBe('{"a":"here, earlier"}')

    // The replay records the batch, and what it stages again is no news to the person.
    const report = await again.sync()
    expect(report.push.replayed).toBe(true)
    expect(
      report.pull.deferred + (report.push.deferred ?? 0) + (report.secondPull?.deferred ?? 0)
    ).toBe(0)
    expect(report.deferred).toBe(1)

    await again.engine.applyDeferred()
    expect(await again.text(APP)).toBe('{"a":"there, later"}')
    expect((await again.sync()).push.committed).toBeNull()
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"there, later"}'))
    await again.assertStateMatchesDisk()
  })
})
