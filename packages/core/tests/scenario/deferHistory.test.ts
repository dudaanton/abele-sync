import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serverHarness, type Harness } from '../helpers/harness.js'
import { shaOf } from '../helpers/seed.js'
import { head, pairOf } from '../helpers/deferPair.js'

/**
 * Many staged answers in one push: each looks through its file's
 * history for the version holding what this device sent. The lookups run a few at a time, and
 * what they stage is what one at a time staged, in the same order.
 */

let h: Harness, account: string

beforeAll(async () => {
  h = await serverHarness()
  account = (await h.account()).accountToken
})
afterAll(async () => {
  await h.close()
})

const FILES = 12
const config = (k: number): string => `.obsidian/plugins/p${String(k).padStart(2, '0')}/data.json`

describe('a push that stages many answers', () => {
  it('looks through the histories a few at a time and stages every head as before', async () => {
    const extra: Record<string, string> = {}
    for (let k = 0; k < FILES; k++) extra[config(k)] = `{"k":${k}}`
    const { a, b, seeder } = await pairOf(h, account, 'defer-many-heads', extra)
    for (let k = 0; k < FILES; k++) await a.write(config(k), `{"k":${k},"by":"A"}`)
    for (let k = 0; k < FILES; k++) await b.write(config(k), `{"k":${k},"by":"B"}`)
    await b.sync()

    const versions = a.client.versions.bind(a.client)
    let inFlight = 0
    let most = 0
    a.client.versions = async (...args) => {
      most = Math.max(most, ++inFlight)
      try {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return await versions(...args)
      } finally {
        inFlight--
      }
    }
    const report = await a.sync()

    expect(most).toBeGreaterThan(1)
    expect(report.deferred).toBe(FILES)
    const staged = await a.engine.deferred()
    expect(staged.map((one) => one.path).sort()).toEqual(
      Array.from({ length: FILES }, (_, k) => config(k))
    )
    for (const one of staged) {
      expect(one.actor.name).toBe('B')
      const k = Number(one.path.slice('.obsidian/plugins/p'.length, -'/data.json'.length))
      expect(one.sha).toBe(await shaOf(`{"k":${k},"by":"B"}`))
      expect(await a.text(one.path)).toBe(`{"k":${k},"by":"A"}`)
    }
    const lines = a.lines.filter((line) => line.includes('staged, not written'))
    expect(lines).toEqual(
      Array.from(
        { length: FILES },
        (_, k) => `push: the vault keeps B's ${config(k)}; staged, not written`
      )
    )
    // Nothing more goes out until the person decides; then the heads are written.
    expect((await a.sync()).push.committed).toBeNull()
    await a.engine.applyDeferred()
    for (let k = 0; k < FILES; k++) {
      expect(await a.text(config(k))).toBe(`{"k":${k},"by":"B"}`)
      expect((await head(seeder, config(k)))?.sha).toBe(await shaOf(`{"k":${k},"by":"B"}`))
    }
    await a.assertStateMatchesDisk()
  })
})
