import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

// Unlike ordinary developer tests, this gate must never silently skip PostgreSQL.
const url = process.env.ABELE_TEST_PG_URL
try {
  if (!url) throw new Error('ABELE_TEST_PG_URL is required; use npm run test:sql:disposable')
  if (!['postgres:', 'postgresql:'].includes(new URL(url).protocol)) {
    throw new Error('a PostgreSQL URL is required')
  }
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 })
  try {
    await pool.query('select 1')
  } finally {
    await pool.end()
  }
} catch (error) {
  // Never echo a credential-bearing URL, even when a driver's error does.
  console.error(
    !url
      ? 'ABELE_TEST_PG_URL is required; use npm run test:sql:disposable'
      : error.message === 'a PostgreSQL URL is required'
        ? error.message
        : 'required PostgreSQL preflight failed'
  )
  process.exit(1)
}
const root = fileURLToPath(new URL('../', import.meta.url))
const filters = process.argv.slice(2)
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    // One worker matches the required 1-CPU PG container. Migration-heavy DDL/drop
    // workloads must not contend with another file's ten-second cleanup hook.
    '--maxWorkers=1',
    ...(filters.length ? filters : ['packages/server/tests/integration']),
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, ABELE_REQUIRE_PG: '1' } }
)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', () => {
  console.error('SQL test runner could not start')
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
