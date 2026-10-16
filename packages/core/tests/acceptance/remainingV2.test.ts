import { it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import {
  facetEngineOptions,
  MANY_FILES_MS,
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
    number === 107 ? MANY_FILES_MS : 120_000
  )
