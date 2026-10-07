import { readFileSync } from 'node:fs'
import { openInspectionDb } from '../packages/server/dist/db/connect.js'
import { currentSchema, migrationChain } from '../packages/server/dist/db/migrate.js'
import {
  assertMigrationAncestry,
  assertScopedSchemaShape,
  assertUpgradeEvidence,
  readMigrationJournal,
} from '../packages/server/dist/db/upgradePreflight.js'

// Read-only gate. No migration, journal repair or backup is performed by this command.
let handle
try {
  const evidence = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  assertUpgradeEvidence(evidence)
  if (!process.env.ABELE_DATABASE_URL) throw new Error('ABELE_DATABASE_URL is required')
  handle = openInspectionDb(process.env.ABELE_DATABASE_URL)
  const schema = await currentSchema(handle.db)
  const journal = await readMigrationJournal(handle.db, schema)
  assertMigrationAncestry(journal, migrationChain)
  await assertScopedSchemaShape(handle.db, schema, journal)
  console.log(JSON.stringify({ evidence, journal, targetChain: migrationChain }, null, 2))
} catch {
  console.error(
    'upgrade preflight failed: require valid evidence, reachable database and exact migration ancestry; never edit journals'
  )
  process.exitCode = 1
} finally {
  await handle?.close()
}
