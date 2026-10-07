import { expect, it } from 'vitest'
import { isInventorySelect } from '../../../../scripts/query-cost-analysis.mjs'
import { validateCostReport } from '../../../../scripts/validate-cost-report.mjs'
const column = (name: string) => ({
  kind: 'ReferenceNode',
  column: { kind: 'ColumnNode', column: { kind: 'IdentifierNode', name } },
})
const predicate = (op: string, value: any = 'one') => ({
  kind: 'BinaryOperationNode',
  leftOperand: column('id'),
  operator: { kind: 'OperatorNode', operator: op },
  rightOperand: { kind: 'ValueNode', value },
})
const query = (where: any, limit?: number) => ({
  kind: 'SelectQueryNode',
  from: {
    kind: 'FromNode',
    froms: [
      {
        kind: 'TableNode',
        table: {
          kind: 'SchemableIdentifierNode',
          identifier: { kind: 'IdentifierNode', name: 'files' },
        },
      },
    ],
  },
  selections: [{ kind: 'SelectionNode', selection: column('path') }],
  where: { kind: 'WhereNode', where },
  ...(limit === undefined
    ? {}
    : { limit: { kind: 'LimitNode', limit: { kind: 'ValueNode', value: limit } } }),
})
it('rejects inequality/unbounded cursor scans despite identity column names and only accepts bounded/equality access', () => {
  expect(isInventorySelect(query(predicate('!=')))).toBe(true)
  expect(isInventorySelect(query(predicate('>')))).toBe(true)
  expect(
    isInventorySelect(query({ kind: 'OrNode', left: predicate('='), right: predicate('>') }))
  ).toBe(true)
  expect(isInventorySelect(query(predicate('=')))).toBe(false)
  expect(isInventorySelect(query(predicate('>'), 1000))).toBe(false)
  expect(isInventorySelect(query(predicate('>'), 1001))).toBe(true)
})
const row = (mode: string, files: number, queriesPerCommit = 21) => ({
  mode,
  files,
  samples: 20,
  p95Ms: 1,
  peakRssBytes: 1,
  commitParserCalls: 0,
  groupQueriesPerCommit: mode === 'group' ? 8 : 0,
  personalInventoryScans: 0,
  queriesPerCommit,
  ...(mode === 'group'
    ? {
        bootstrap: { parserCalls: files + 1 },
        worker: { ready: true, parserCalls: 20, laggedRead: 'scope_updating', readMs: 1 },
      }
    : {}),
})
const report = (rows: any[]) => ({ container: { memoryBytes: 2147483648, cpuLimit: 2 }, rows })
it('requires genuinely different volumes per mode and checks every intermediate query count', () => {
  const modes = ['none', 'folder', 'group']
  expect(() =>
    validateCostReport(report(modes.flatMap((mode) => [row(mode, 100), row(mode, 100)])))
  ).toThrow()
  expect(() =>
    validateCostReport(
      report(modes.flatMap((mode) => [row(mode, 100), row(mode, 1000, 42), row(mode, 5000)]))
    )
  ).toThrow()
  expect(() =>
    validateCostReport(
      report(modes.flatMap((mode) => [row(mode, 100), row(mode, 1000), row(mode, 5000)]))
    )
  ).not.toThrow()
})
