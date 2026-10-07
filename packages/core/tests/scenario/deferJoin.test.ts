import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { encodeText, MemoryFileSystem } from '../../src/index.js'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { Device, nextMtime } from '../helpers/device.js'
import { shaOf } from '../helpers/seed.js'
import { APP, CONFIG, PLUGIN, head, pairOf } from '../helpers/deferPair.js'

/**
 * A push answered with the server's bytes for a staged path: the answer is staged like a pulled change, never written onto the
 * config folder while Obsidian runs. The entry is recorded against the version that holds what
 * this device sent, so "Reload" writes the head and "Keep this device's" sends the local bytes
 * again.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

/** A third device, C, with its own app settings on its disk, about to join the pair's vault. */
async function joiner(vaultId: string, prefer?: 'mine' | 'theirs'): Promise<Device> {
  const fs = new MemoryFileSystem()
  await fs.writeAtomic(APP, encodeText('{"a":"C"}'), nextMtime())
  return new Device(h, vaultId, (await h.device(account, vaultId, 'C')).deviceToken, 'C', {
    fs,
    defer: CONFIG,
    ...(prefer === undefined ? {} : { joinPrefer: prefer }),
  })
}

describe('a device joining with settings that differ from the vault', () => {
  it('stages the server copy when the server wins, and keeps its own on the disk', async () => {
    const { vaultId, seeder } = await pairOf(h, account, 'defer-join-theirs')
    const c = await joiner(vaultId, 'theirs')
    const report = await c.sync()

    expect(await c.text(APP)).toBe('{"a":"C"}')
    expect((await c.engine.deferred()).map((one) => one.path).sort()).toEqual(
      [APP, `${PLUGIN}/main.js`, `${PLUGIN}/manifest.json`, `${PLUGIN}/styles.css`].sort()
    )
    expect(report.deferred).toBe(4)
    // Counted once, however many of the run's steps met it.
    expect(
      report.pull.deferred + (report.push.deferred ?? 0) + (report.secondPull?.deferred ?? 0)
    ).toBe(4)
    const now = await head(seeder, APP)
    expect(now?.sha).toBe(await shaOf('{"a":1}'))
    // C's own bytes are a version of the file: nothing is lost.
    const versions = await seeder.versions(now!.file_id)
    expect(versions.map((v) => v.sha)).toContain(await shaOf('{"a":"C"}'))
    // Nothing more goes out, and nothing more is staged.
    const again = await c.sync()
    expect(again.push.committed).toBeNull()
    expect(again.deferred).toBe(4)

    expect((await c.engine.applyDeferred()).skipped).toEqual([])
    expect(await c.text(APP)).toBe('{"a":1}')
    const after = await c.sync()
    expect(after.push.committed).toBeNull()
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":1}'))
    await c.assertStateMatchesDisk()
  })

  it('stages the newer server copy when both are merged', async () => {
    const { vaultId, b, seeder } = await pairOf(h, account, 'defer-join-merge')
    const c = await joiner(vaultId)
    // The vault's copy is newer than C's.
    await b.write(APP, '{"a":"B, later"}')
    await b.sync()
    await c.sync()

    expect(await c.text(APP)).toBe('{"a":"C"}')
    const staged = (await c.engine.deferred()).find((one) => one.path === APP)
    expect(staged?.sha).toBe(await shaOf('{"a":"B, later"}'))
    expect(staged?.actor.name).toBe('B')
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"B, later"}'))
    await c.engine.applyDeferred()
    expect(await c.text(APP)).toBe('{"a":"B, later"}')
    expect((await c.sync()).push.committed).toBeNull()
  })

  it('sends its own after all when it keeps it', async () => {
    const { vaultId, b, seeder } = await pairOf(h, account, 'defer-join-keep')
    const c = await joiner(vaultId, 'theirs')
    await c.sync()

    expect((await c.engine.keepLocal([APP])).kept).toEqual([APP])
    await c.sync()
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"C"}'))
    expect(await c.text(APP)).toBe('{"a":"C"}')
    await b.sync()
    expect(await b.text(APP)).toBe('{"a":"C"}')
  })

  it('writes at once when this device wins: nothing comes back', async () => {
    const { vaultId, seeder } = await pairOf(h, account, 'defer-join-mine')
    const c = await joiner(vaultId, 'mine')
    await c.sync()
    expect(await c.text(APP)).toBe('{"a":"C"}')
    expect((await c.engine.deferred()).map((one) => one.path)).not.toContain(APP)
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":"C"}'))
  })
})
