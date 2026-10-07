import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
export function validateCostReport(report) {
  assert.equal(report.container.memoryBytes, 2147483648)
  assert.equal(report.container.cpuLimit, 2)
  assert.deepEqual([...new Set(report.rows.map((row) => row.mode))].sort(), [
    'folder',
    'group',
    'none',
  ])
  assert.ok(report.rows.length >= 6, 'two or more synthetic volumes required')
  for (const row of report.rows) {
    assert.ok(row.files >= 100 && row.samples >= 10 && row.p95Ms > 0 && row.peakRssBytes > 0)
    assert.equal(row.commitParserCalls, 0, 'personal commits may never parse group YAML')
    if (row.mode !== 'group') assert.equal(row.groupQueriesPerCommit, 0)
    else {
      assert.ok(row.groupQueriesPerCommit > 0)
      assert.equal(row.bootstrap.parserCalls, row.files + 1)
      assert.equal(row.worker.ready, true)
      assert.equal(row.worker.parserCalls, row.samples)
      assert.equal(row.worker.laggedRead, 'scope_updating')
      assert.ok(row.worker.readMs > 0)
    }
    assert.equal(
      row.personalInventoryScans,
      0,
      'no whole-vault inventory scan inside personal commit'
    )
  }
  for (const mode of ['none', 'folder', 'group']) {
    const rows = report.rows.filter((row) => row.mode === mode).sort((a, b) => a.files - b.files)
    assert.ok(
      new Set(rows.map((row) => row.files)).size >= 2,
      'different synthetic volumes required in every mode'
    )
    assert.equal(
      new Set(rows.map((row) => row.files)).size,
      rows.length,
      'duplicate mode/volume rows cannot substitute for coverage'
    )
    assert.ok(
      rows.every((row) => row.queriesPerCommit === rows[0].queriesPerCommit),
      'query count must not scale with synthetic vault volume'
    )
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  assert.ok(file, 'measurement report required')
  validateCostReport(JSON.parse(readFileSync(file, 'utf8')))
  console.log(
    'PASS container bounds, measured volumes, zero personal parser/inventory work, fixed query counts, worker readiness'
  )
}
