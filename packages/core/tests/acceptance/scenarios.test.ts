import { afterAll, afterEach, describe, it } from 'vitest'
import { dropFileDatabase } from '@abele/sync-server/tests/helpers/tempDb.js'
import { scenarios } from './manifest.js'
import { acceptanceFixture, type AcceptanceFixture } from './fixture.js'
import { pendingScenario, serverFacet, stage1ServerFacets } from './drivers.js'
import { stage2ServerFacet, stage2ServerFacets } from './serverStage2.js'
import { groupServerFacet, groupServerFacets } from './serverGroups.js'
import { externalServerFacet, externalServerFacets } from './serverExternal.js'
import { conflictServerFacet, conflictServerFacets } from './serverConflicts.js'
import {
  facetEngineOptions,
  MANY_FILES_MS,
  remainingServerFacet,
  remainingServerFacets,
} from './serverRemaining.js'

afterAll(dropFileDatabase)
for (const dialect of process.env.ABELE_TEST_PG_URL
  ? (['sqlite', 'pg'] as const)
  : (['sqlite'] as const)) {
  describe(`numbered acceptance (${dialect})`, () => {
    let fixture: AcceptanceFixture | undefined
    // Two physical PG databases must be closed/dropped on the disposable stand's
    // single CPU. Cleanup is infrastructure work, not the scenario's progress budget.
    afterEach(
      async () => {
        const owned = fixture
        fixture = undefined
        await owned?.close()
      },
      dialect === 'pg' ? 30_000 : 10_000
    )
    for (const scenario of scenarios) {
      const title = `${String(scenario.number).padStart(3, '0')}: ${scenario.text}`
      if (
        stage1ServerFacets.has(scenario.number) ||
        stage2ServerFacets.has(scenario.number) ||
        groupServerFacets.has(scenario.number) ||
        externalServerFacets.has(scenario.number) ||
        conflictServerFacets.has(scenario.number) ||
        remainingServerFacets.has(scenario.number)
      ) {
        it(
          `${title} [server facet; live evidence pending]`,
          async () => {
            fixture = await acceptanceFixture(
              dialect,
              undefined,
              facetEngineOptions(scenario.number)
            )
            if (stage1ServerFacets.has(scenario.number)) await serverFacet(scenario.number, fixture)
            else if (stage2ServerFacets.has(scenario.number))
              await stage2ServerFacet(scenario.number, fixture)
            else if (groupServerFacets.has(scenario.number))
              await groupServerFacet(scenario.number, fixture)
            else if (externalServerFacets.has(scenario.number))
              await externalServerFacet(scenario.number, fixture)
            else if (conflictServerFacets.has(scenario.number))
              await conflictServerFacet(scenario.number, fixture)
            else await remainingServerFacet(scenario.number, fixture)
          },
          scenario.number === 107 ? MANY_FILES_MS : dialect === 'pg' ? 60_000 : 20_000
        )
      } else {
        // 117–124 are physical-iPhone/plugin UI obligations, not missing SQL/core facets.
        // drivers.ts names each exact platform check. README requires retaining every
        // pending numbered scenario as it.fails; none is removed from the count.
        it.fails(`${title} [plugin/iPhone evidence pending]`, async () => {
          await pendingScenario(scenario.number)
        })
      }
    }
  })
}
