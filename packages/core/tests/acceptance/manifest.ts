import { readFileSync } from 'node:fs'
import { z } from 'zod'

export const ScenarioSchema = z
  .object({
    number: z.number().int().min(1).max(124),
    text: z.string().min(1),
    driver: z.enum(['core', 'iphone']),
    requiredEvidence: z.array(z.enum(['server', 'Mac', 'iPhone'])).min(1),
    assertions: z.array(z.string().min(1)).min(1),
  })
  .strict()
export const scenarios = z
  .array(ScenarioSchema)
  .parse(JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8')))
export type Scenario = z.infer<typeof ScenarioSchema>

/** A green core test is not proof that the Mac UI/camera or physical phone was checked. */
export const EvidenceSchema = z
  .object({
    scenario: z.number().int().min(1).max(124),
    platform: z.enum(['server', 'Mac', 'iPhone']),
    kind: z.enum(['automated', 'live']),
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    checked_at: z.string().datetime({ offset: true }),
    artifacts: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .refine((e) => e.platform === 'server' || e.kind === 'live', 'Mac/iPhone require live evidence')
export type Evidence = z.infer<typeof EvidenceSchema>
export function missingEvidence(number: number, records: Evidence[]) {
  const scenario = scenarios.find((s) => s.number === number)
  if (scenario === undefined) throw new Error('unknown acceptance scenario')
  const evidence = records
    .map((record) => EvidenceSchema.parse(record))
    .filter((record) => record.scenario === number)
  return scenario.requiredEvidence.filter(
    (platform) => !evidence.some((record) => record.platform === platform)
  )
}
