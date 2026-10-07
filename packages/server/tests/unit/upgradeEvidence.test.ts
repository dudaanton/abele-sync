import { describe, expect, it } from 'vitest'
import { assertMigrationAncestry, assertUpgradeEvidence } from '../../src/db/upgradePreflight.js'

const evidence = {
  database: 'synthetic-local',
  sourceRevision: 'a'.repeat(40),
  writersStopped: true,
  collectorsStopped: true,
  databaseBackup: 'verified snapshot identifier',
  blobBackup: 'verified blob snapshot identifier',
}

describe('upgrade evidence gate', () => {
  it('reports unsupported schemas in the migration ancestry error', () => {
    expect(() => assertMigrationAncestry(['unsupported_schema'], ['001_init'])).toThrow(
      'unsupported schemas'
    )
  })
  it('requires a named database, deployed revision, stopped writers/collectors and both backups', () => {
    expect(() => assertUpgradeEvidence(evidence)).not.toThrow()
    for (const key of Object.keys(evidence)) {
      const missing = { ...evidence, [key]: undefined }
      expect(() => assertUpgradeEvidence(missing)).toThrow(/upgrade evidence/)
    }
    expect(() => assertUpgradeEvidence({ ...evidence, writersStopped: false })).toThrow()
    expect(() => assertUpgradeEvidence({ ...evidence, collectorsStopped: false })).toThrow()
    expect(() => assertUpgradeEvidence({ ...evidence, sourceRevision: 'main' })).toThrow()
    expect(() => assertUpgradeEvidence({ ...evidence, blobBackup: ' ' })).toThrow()
  })
})
