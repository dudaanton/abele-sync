import { it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import {
  facetEngineOptions,
  remainingServerFacet,
  remainingServerFacets,
} from './serverRemaining.js'

for (const number of remainingServerFacets)
  it(
    `${number} verifies the remaining production V2 core/server guarantee`,
    async () => {
      const f = await acceptanceFixture('sqlite', undefined, facetEngineOptions(number))
      try {
        await remainingServerFacet(number, f)
      } finally {
        await f.close()
      }
    },
    // The same bounded 1,005-file facet as numbered acceptance scenario 107;
    // both copies run concurrently in the full suite on a two-core runner.
    number === 107 ? 600_000 : 120_000
  )
