import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

test('CI crash shards cover every collected case exactly once and all gate the required status', (context) => {
  const { jobs } = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const recovery = jobs.crash_recovery
  assert.ok(recovery, 'the exhaustive recovery file needs independent CI jobs')
  assert.equal(recovery.strategy['fail-fast'], false)
  const shards = recovery.strategy.matrix.include
  assert.equal(shards.length, 6)
  assert.equal(new Set(shards.map((shard) => shard.name)).size, 6)
  const runRecovery = recovery.steps.find((step) => step.env?.CRASH_GROUP)
  assert.equal(runRecovery.env.CRASH_GROUP, '${{ matrix.pattern }}')
  assert.match(runRecovery.run, /groupCrashRecovery\.test\.ts/)
  assert.match(runRecovery.run, /--testNamePattern "\$CRASH_GROUP"/)
  assert.match(runRecovery.run, /--maxWorkers=2/)

  const ordinary = jobs.checks.steps.find((step) => step.run?.startsWith('npm test'))
  assert.match(ordinary.run, /--exclude ['"]\*\*\/groupCrashRecovery\.test\.ts['"]/)
  assert.match(ordinary.run, /--maxWorkers=2/)
  const ancillary = jobs.checks.steps.find((step) => step.env?.CRASH_ANCILLARY)
  assert.ok(ancillary, 'the non-matrix regressions and allocation bound must still run')
  assert.match(ancillary.run, /groupCrashRecovery\.test\.ts/)
  assert.match(ancillary.run, /--testNamePattern "\$CRASH_ANCILLARY"/)
  assert.match(ancillary.run, /--maxWorkers=2/)

  const dir = mkdtempSync(join(tmpdir(), 'abele-ci-shards-'))
  let cases
  try {
    const output = join(dir, 'cases.json')
    execFileSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'list',
        'packages/node/tests/unit/groupCrashRecovery.test.ts',
        '--no-staticParse',
        '--maxWorkers=2',
        '--json',
        output,
      ],
      { stdio: 'pipe', timeout: 120_000 }
    )
    cases = JSON.parse(readFileSync(output, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const patterns = [...shards.map((shard) => shard.pattern), ancillary.env.CRASH_ANCILLARY].map(
    (pattern) => new RegExp(pattern)
  )
  const counts = patterns.map(() => 0)
  assert.ok(cases.length > 9000, 'collect the runtime matrix, not static loop templates')
  for (const entry of cases) {
    const destinations = patterns.flatMap((pattern, index) =>
      pattern.test(entry.name) ? [index] : []
    )
    assert.equal(destinations.length, 1, `missing or duplicate coverage: ${entry.name}`)
    counts[destinations[0]]++
  }
  assert.ok(
    counts.every((count) => count > 0),
    `empty CI shard: ${counts}`
  )
  context.diagnostic(
    `Collected ${cases.length} cases: ${counts.join(' + ')} across six groups and ancillary regressions`
  )
  const allocation = cases.find((entry) => entry.name.includes('bounds scratch buffers'))
  assert.ok(allocation)
  assert.ok(patterns.at(-1).test(allocation.name), 'retain the allocation regression')

  assert.deepEqual([...jobs.test.needs].sort(), ['checks', 'crash_recovery'])
  assert.equal(jobs.test.if, 'always()')
  const aggregate = jobs.test.steps.find((step) => step.env?.CHECKS_RESULT)
  assert.equal(aggregate.env.CHECKS_RESULT, '${{ needs.checks.result }}')
  assert.equal(aggregate.env.RECOVERY_RESULT, '${{ needs.crash_recovery.result }}')
  assert.equal(
    aggregate.run.trim(),
    'test "$CHECKS_RESULT" = success && test "$RECOVERY_RESULT" = success'
  )
})
