import { it } from 'vitest'
import { acceptanceFixture } from './fixture.js'
import {
  facetEngineOptions,
  remainingServerFacet,
  remainingServerFacets,
} from './serverRemaining.js'

it.each([...remainingServerFacets])(
  '%i verifies the remaining production V2 core/server guarantee',
  async (number) => {
    const f = await acceptanceFixture('sqlite', undefined, facetEngineOptions(number))
    try {
      await remainingServerFacet(number, f)
    } finally {
      await f.close()
    }
  },
  120_000
)
