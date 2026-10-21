import { readdirSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { generate, shrink, type Trace } from './actions.js'
import { replay, saveRegression } from './trace.js'

it('shrinks to an irreducible failure and preserves the seed', async () => {
  const result = await shrink(
    { seed: 7, actions: [{ kind: 'sync' }, { kind: 'pause' }, { kind: 'stop' }] },
    async (t) => t.actions.some((a) => a.kind === 'pause')
  )
  expect(result).toEqual({ seed: 7, actions: [{ kind: 'pause' }] })
})

const dir = new URL('./regressions/', import.meta.url)
for (const name of readdirSync(dir)
  .filter((n) => n.endsWith('.json'))
  .sort()) {
  const trace = JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as Trace
  // Future bug fields retain expected-failure semantics; fixed regressions have no marker.
  const test = trace.bug ? it.fails : it
  test(`replays JSON regression ${name}${trace.bug ? ` (${trace.bug})` : ''}`, async () => {
    await replay(trace)
  })
}

it.skipIf(process.env.SIM_SHRINK_KNOWN !== '1')(
  'minimizes the directed JSON failure traces',
  async () => {
    for (const name of ['d001-same-sha', 'd002-pause', 'd002-stop']) {
      const trace = JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as Trace
      const signature = trace.bug === 'D-001' ? 'I3:' : 'I4:'
      const minimal = await shrink(trace, async (candidate) => {
        try {
          await replay(candidate)
          return false
        } catch (error) {
          return error instanceof Error && error.message.startsWith(signature)
        }
      })
      await saveRegression(minimal, name)
      expect(minimal.actions.length).toBeLessThanOrEqual(trace.actions.length)
    }
  },
  Number(process.env.SIM_TIMEOUT ?? 90_000)
)

it(
  'runs bounded seeded random sequences and shrinks failures',
  async () => {
    const start = Number(process.env.SIM_SEED ?? 1),
      runs = Number(process.env.SIM_RUNS ?? 20)
    for (let seed = start; seed < start + runs; seed++) {
      const trace = generate(seed, Number(process.env.SIM_ACTIONS ?? 25))
      try {
        await replay(trace)
      } catch (error) {
        const signature = error instanceof Error ? error.message.split('\n')[0] : String(error)
        const minimal = await shrink(trace, async (candidate) => {
          try {
            await replay(candidate)
            return false
          } catch (next) {
            return (
              (next instanceof Error ? next.message.split('\n')[0] : String(next)) === signature
            )
          }
        })
        if (process.env.SIM_SAVE === '1') await saveRegression(minimal, `seed-${seed}`)
        throw new Error(`seed ${seed}: ${signature}\n${JSON.stringify(minimal)}`, { cause: error })
      }
    }
  },
  Number(process.env.SIM_TIMEOUT ?? 90_000)
)
