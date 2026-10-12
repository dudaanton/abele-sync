import { describe, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { conflictServerFacet, conflictServerFacets } from './serverConflicts.js'

describe.each(process.env.ABELE_TEST_PG_URL ? (['sqlite', 'pg'] as const) : (['sqlite'] as const))(
  'cross-server conflict engines (%s)',
  (dialect) => {
    it.each([...conflictServerFacets])(
      '%i preserves both variants, forwards one copy and becomes idle',
      async (number) => {
        const f = await acceptanceFixture(dialect)
        try {
          await conflictServerFacet(number, f)
        } finally {
          await f.close()
        }
      },
      dialect === 'pg' ? 60_000 : 20_000
    )
  }
)
