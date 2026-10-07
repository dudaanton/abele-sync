const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const value of Object.values(node))
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit))
    else if (value && typeof value === 'object') walk(value, visit)
}
function identityBound(node, aliases, unqualified) {
  if (!node) return false
  if (node.kind === 'WhereNode') return identityBound(node.where, aliases, unqualified)
  if (node.kind === 'ParensNode') return identityBound(node.node, aliases, unqualified)
  if (node.kind === 'AndNode')
    return (
      identityBound(node.left, aliases, unqualified) ||
      identityBound(node.right, aliases, unqualified)
    )
  if (node.kind === 'OrNode')
    return (
      identityBound(node.left, aliases, unqualified) &&
      identityBound(node.right, aliases, unqualified)
    )
  if (node.kind !== 'BinaryOperationNode') return false
  const ref = node.leftOperand,
    value = node.rightOperand,
    table = ref?.table?.table?.identifier?.name
  if (
    ref?.kind !== 'ReferenceNode' ||
    !['id', 'path_ci'].includes(ref.column?.column?.name) ||
    (table ? !aliases.has(table) : !unqualified)
  )
    return false
  if (node.operator?.operator === '=')
    return value?.kind === 'ValueNode' && typeof value.value === 'string' && value.value.length > 0
  if (node.operator?.operator === 'in')
    return (
      value?.kind === 'ValueListNode' &&
      value.values.length > 0 &&
      value.values.length <= 32 &&
      value.values.every(
        (v) => v.kind === 'ValueNode' && typeof v.value === 'string' && v.value.length > 0
      )
    )
  return false
}
/** A column name is not a bound. Only actual files-key equalities/bounded IN
 * predicates, safely composed AND/OR, or explicit <=1000 row pages qualify.
 */
export function isInventorySelect(node) {
  if (node.kind !== 'SelectQueryNode') return false
  const aliases = new Set()
  let aggregate = false
  const sources = [...(node.from?.froms ?? []), ...(node.joins ?? []).map((join) => join.table)]
  for (const source of sources) {
    if (source.kind === 'TableNode' && source.table?.identifier?.name === 'files')
      aliases.add('files')
    if (
      source.kind === 'AliasNode' &&
      source.node?.kind === 'TableNode' &&
      source.node.table?.identifier?.name === 'files'
    )
      aliases.add(source.alias.name)
  }
  // Nested selects are checked too; unrelated table keys cannot mask a scan.
  let nested = false
  walk(node, (n) => {
    if (n !== node && n.kind === 'SelectQueryNode' && isInventorySelect(n)) nested = true
  })
  if (nested) return true
  if (!aliases.size) return false
  walk(node.selections, (n) => {
    if (n.kind === 'AggregateFunctionNode') aggregate = true
  })
  if (aggregate) return false
  const limit = node.limit?.limit
  if (
    limit?.kind === 'ValueNode' &&
    Number.isSafeInteger(limit.value) &&
    limit.value >= 1 &&
    limit.value <= 1000
  )
    return false
  const unqualified = sources.length === 1
  return !identityBound(node.where, aliases, unqualified)
}
