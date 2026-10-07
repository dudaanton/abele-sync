import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { shaOf } from '../helpers/seed.js'
import { APP, PLUGIN, head, pairOf } from '../helpers/deferPair.js'

/**
 * Staged changes decided by the versions a host showed: the host
 * names the version ids it put in front of the person, and the engine writes or keeps only the
 * records that still stand at one of them. A record replaced since — a sync that ran before the
 * answer staged a newer change to the same file — is neither written nor kept, and comes back
 * with those never shown, so the host can ask about them.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

const MAIN = `${PLUGIN}/main.js`

/** The version id staged for a path, as the host would have shown it. */
async function stagedVersion(
  engine: { deferred(): Promise<{ path: string; version_id: string }[]> },
  path: string
) {
  const one = (await engine.deferred()).find((c) => c.path === path)
  expect(one).toBeDefined()
  return one!.version_id
}

describe('a host that answers for the versions it showed', () => {
  it('applies only the shown records and returns the rest, which stay staged', async () => {
    const { a, b } = await pairOf(h, account, 'shown-apply')
    await b.write(APP, '{"a":2}')
    await b.write(MAIN, 'main(2)')
    await b.sync()
    await a.sync()
    const shown = await stagedVersion(a.engine, APP)
    const other = await stagedVersion(a.engine, MAIN)

    const result = await a.engine.applyDeferred([shown])
    expect(result.applied).toEqual([APP])
    expect(result.skipped).toEqual([])
    expect(result.unshown?.map((c) => [c.path, c.version_id])).toEqual([[MAIN, other]])
    expect(await a.text(APP)).toBe('{"a":2}')
    expect(await a.text(MAIN)).toBe('main()')
    expect(a.engine.status.deferred).toBe(1)
    expect((await a.engine.deferred()).map((c) => c.path)).toEqual([MAIN])

    // Asked again, the rest is written.
    const next = await a.engine.applyDeferred([other])
    expect(next).toEqual({ applied: [MAIN], skipped: [], unshown: [] })
    expect(await a.text(MAIN)).toBe('main(2)')
    expect(a.engine.status.deferred).toBe(0)
    await a.assertStateMatchesDisk()
  })

  it('does not apply a record replaced after it was shown, and returns the newer one', async () => {
    const { a, b } = await pairOf(h, account, 'shown-apply-replaced')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    const shown = await stagedVersion(a.engine, APP)
    await b.write(APP, '{"a":3}')
    await b.sync()
    await a.sync()
    const newer = await stagedVersion(a.engine, APP)
    expect(newer).not.toBe(shown)

    const result = await a.engine.applyDeferred([shown])
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.unshown?.map((c) => c.version_id)).toEqual([newer])
    expect(await a.text(APP)).toBe('{"a":1}')
    expect(a.engine.status.deferred).toBe(1)
  })

  it('does not apply what a sync running under the answer staged over the shown version', async () => {
    const { a, b } = await pairOf(h, account, 'shown-apply-race')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    const shown = await stagedVersion(a.engine, APP)
    await b.write(APP, '{"a":3}')
    await b.sync()

    // The answer arrives while a sync is running; it waits for that sync, which stages {"a":3}.
    const running = a.sync()
    const result = await a.engine.applyDeferred([shown])
    await running
    expect(result.applied).toEqual([])
    expect(result.unshown?.map((c) => c.sha)).toEqual([await shaOf('{"a":3}')])
    expect(await a.text(APP)).toBe('{"a":1}')
    expect(a.engine.status.deferred).toBe(1)
  })

  it('does not keep a record replaced after it was shown, and returns the newer one', async () => {
    const { a, b, seeder } = await pairOf(h, account, 'shown-keep-replaced')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    const shown = await stagedVersion(a.engine, APP)
    await b.write(APP, '{"a":3}')
    await b.sync()
    await a.sync()
    const newer = await stagedVersion(a.engine, APP)
    const commits = a.stats.commits

    for (const paths of [undefined, [APP]]) {
      const result = await a.engine.keepLocal(paths, [shown])
      expect(result.kept).toEqual([])
      expect(result.left).toEqual([])
      expect(result.unshown?.map((c) => c.version_id)).toEqual([newer])
    }
    expect(a.engine.status.deferred).toBe(1)
    const report = await a.sync()
    expect(report.push.committed).toBeNull()
    expect(a.stats.commits).toBe(commits)
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":3}'))
    expect(await a.text(APP)).toBe('{"a":1}')
  })

  it('keeps only the shown records and returns the unshown ones among those named', async () => {
    const { a, b, seeder } = await pairOf(h, account, 'shown-keep')
    await b.write(APP, '{"a":2}')
    await b.write(MAIN, 'main(2)')
    await b.sync()
    await a.sync()
    const shown = await stagedVersion(a.engine, APP)
    const other = await stagedVersion(a.engine, MAIN)

    const result = await a.engine.keepLocal(undefined, [shown])
    expect(result.kept).toEqual([APP])
    expect(result.left).toEqual([])
    expect(result.unshown?.map((c) => [c.path, c.version_id])).toEqual([[MAIN, other]])
    expect((await a.engine.deferred()).map((c) => c.path)).toEqual([MAIN])
    // Paths narrow further: a shown record outside them is neither kept nor returned.
    expect(await a.engine.keepLocal([APP], [other])).toEqual({ kept: [], left: [], unshown: [] })

    await a.sync()
    expect((await head(seeder, APP))?.sha).toBe(await shaOf('{"a":1}'))
    expect((await head(seeder, MAIN))?.sha).toBe(await shaOf('main(2)'))
    expect(await a.text(MAIN)).toBe('main()')
    expect(a.engine.status.deferred).toBe(1)
  })

  it('answers as before without version ids: everything staged, and no unshown list', async () => {
    const { a, b } = await pairOf(h, account, 'shown-none')
    await b.write(APP, '{"a":2}')
    await b.sync()
    await a.sync()
    expect(await a.engine.applyDeferred()).toEqual({ applied: [APP], skipped: [] })
    await b.write(APP, '{"a":3}')
    await b.sync()
    await a.sync()
    expect(await a.engine.keepLocal()).toEqual({ kept: [APP], left: [] })
  })
})
