import { describe, it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import { conflictServerFacet, conflictServerFacets } from './serverConflicts.js'

describe.each(process.env.ABELE_TEST_PG_URL ? (['sqlite', 'pg'] as const) : (['sqlite'] as const))(
  'cross-server conflict engines (%s)',
  (dialect) => {
    for (const number of conflictServerFacets)
      it(
        `${number} preserves both variants, forwards one copy and becomes idle`,
        async () => {
          const f = await acceptanceFixture(dialect)
          try {
            await conflictServerFacet(number, f)
          } finally {
            await f.close()
          }
        },
        // Facet 91 waits for replica/ledger convergence; facet 99 also provisions
        // and verifies three groups on each server.
        // Scheduling delays under load must not consume its ordinary 20s budget;
        // all variant, privacy, forwarding and post-restart idle assertions stay exact.
        dialect === 'pg' || number === 91 || number === 99 ? 60_000 : 20_000
      )
  }
)
