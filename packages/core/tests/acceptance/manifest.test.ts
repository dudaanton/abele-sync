import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { EvidenceSchema, missingEvidence, scenarios } from './manifest.js'
import { platformScenarioReasons, stage1ServerFacets } from './drivers.js'
import { stage2ServerFacets } from './serverStage2.js'
import { groupServerFacets } from './serverGroups.js'
import { externalServerFacets } from './serverExternal.js'
import { conflictServerFacets } from './serverConflicts.js'
import { remainingServerFacets } from './serverRemaining.js'

it('registers every numbered Russian scenario verbatim, with driver, assertion and evidence obligations', () => {
  expect(scenarios.map((s) => s.number)).toEqual(
    Array.from({ length: 124 }, (_, index) => index + 1)
  )
  // Hash of the numbered lines in the binding scenarios-note, excluding headings/frontmatter.
  const lines = scenarios.map((s) => `${s.number}. ${s.text}`).join('\n')
  expect(createHash('sha256').update(lines).digest('hex')).toBe(
    'c46dbe670df29e93f6bbe497536734c887919b03441dc98d7490074beba0b861'
  )
  for (const scenario of scenarios) {
    const finalOfflinePolicy: Record<number, string> = {
      108: 'Stale edits use ordinary line merge; each distinct overlapping divergence has one conflict file.',
      109: 'Edit beats delete: the file returns with the authored bytes.',
      110: 'mtime is the original edit time; a merge uses the latest original mtime, never server now or a separate sync timestamp.',
    }
    expect(scenario.assertions).toEqual([
      finalOfflinePolicy[scenario.number] ?? scenario.text.split(' → ')[1],
    ])
    expect(scenario.driver).toBe(scenario.number >= 117 ? 'iphone' : 'core')
    expect(scenario.requiredEvidence.length).toBeGreaterThan(0)
    expect(missingEvidence(scenario.number, [])).toEqual(scenario.requiredEvidence)
  }
})
it('never turns core/server simulations into live Mac/iPhone evidence', () => {
  const record = {
    scenario: 117,
    platform: 'iPhone' as const,
    kind: 'automated' as const,
    revision: 'b6d8066'.padEnd(40, '0'),
    checked_at: '2026-10-10T00:00:00Z',
    artifacts: ['synthetic.log'],
  }
  expect(EvidenceSchema.safeParse(record).success).toBe(false)
  expect(missingEvidence(117, [{ ...record, kind: 'live' }])).toEqual([])
  expect(missingEvidence(117, [{ ...record, platform: 'server' }])).toEqual(['iPhone'])
  expect(missingEvidence(2, [{ ...record, scenario: 2, platform: 'server' }])).toEqual(['Mac'])
})

it('leaves only the eight physical-iPhone numbers as explicit expected failures', () => {
  const green = new Set([
    ...stage1ServerFacets,
    ...stage2ServerFacets,
    ...groupServerFacets,
    ...externalServerFacets,
    ...conflictServerFacets,
    ...remainingServerFacets,
  ])
  expect([...green].sort((a, b) => a - b)).toEqual(Array.from({ length: 116 }, (_, i) => i + 1))
  const pending = scenarios.filter((s) => !green.has(s.number)).map((s) => s.number)
  expect(pending).toEqual([117, 118, 119, 120, 121, 122, 123, 124])
  expect(Object.keys(platformScenarioReasons).map(Number)).toEqual(pending)
  for (const number of pending) expect(platformScenarioReasons[number]).toMatch(/iPhone|iOS/)
})
