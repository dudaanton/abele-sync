import { diff3Merge, diffIndices } from 'node-diff3'

export interface MergeResult {
  text: string
  clean: boolean
  /** The complete incoming document must be kept in a separate file. */
  conflictCopy?: true
}

interface LineShape {
  eol: '\r\n' | '\n'
  trailingNewline: boolean
}
const shapeOf = (text: string): LineShape => ({
  eol: text.includes('\r\n') ? '\r\n' : '\n',
  trailingNewline: text.endsWith('\n'),
})
const sameShape = (x: LineShape, y: LineShape): boolean =>
  x.eol === y.eol && x.trailingNewline === y.trailingNewline

/** Head's shape, unless it kept the base's shape or has no shape of its own. */
function shapeForResult(base: string, head: string, incoming: string): LineShape {
  if (head === '') return shapeOf(incoming)
  if (incoming === '') return shapeOf(head)
  const headShape = shapeOf(head)
  return sameShape(headShape, shapeOf(base)) ? shapeOf(incoming) : headShape
}
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}
function joinLines(lines: string[], shape: LineShape): string {
  if (lines.length === 0) return ''
  const text = lines.join(shape.eol)
  return shape.trailingNewline ? text + shape.eol : text
}

function linePassAllowed(base: string[], head: string[], incoming: string[]): boolean {
  if (base.length + head.length + incoming.length > 100_000) return false
  const counts = new Map<string, number>()
  for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1)
  let matches = 0
  for (const side of [head, incoming]) {
    for (const line of side) {
      matches += counts.get(line) ?? 0
      if (matches > 1_000_000) return false
    }
  }
  return true
}

/** Reconcile whole hunks in actual base coordinates, never side-array positions.
 * Adjacent replacements are independent. Overlapping rewrites, shared insertion
 * markers and adjoining resized rewrites are uncertain and require a conflict copy. */
function mergeRegion(base: string[], head: string[], incoming: string[]): string[] | null {
  const patches = [...diffIndices(base, head), ...diffIndices(base, incoming)]
    .map((patch) => ({
      offset: patch.buffer1[0],
      removed: patch.buffer1[1],
      lines: patch.buffer2Content,
    }))
    .sort((a, b) => a.offset - b.offset || a.removed - b.removed)
  const chosen: typeof patches = []
  for (const patch of patches) {
    const last = chosen.at(-1)
    if (last) {
      if (
        last.offset === patch.offset &&
        last.removed === patch.removed &&
        last.lines.length === patch.lines.length &&
        last.lines.every((line, i) => line === patch.lines[i])
      )
        continue
      const end = last.offset + last.removed
      if (end > patch.offset) return null
      if (end === patch.offset) {
        if (!last.removed || !patch.removed) {
          const insert = !last.removed ? last : patch
          const rewrite = !last.removed ? patch : last
          // A pure insertion beside a single, distinct line replacement has
          // proven coordinates. Shared markers or resized rewrites are ambiguous.
          if (
            rewrite.removed !== 1 ||
            rewrite.lines.length !== 1 ||
            insert.lines.includes(rewrite.lines[0]!)
          )
            return null
        } else if (last.removed !== last.lines.length && patch.removed !== patch.lines.length) {
          // Both resized rewrites may hide competing insertions at this boundary.
          return null
        }
      }
    }
    chosen.push(patch)
  }
  const lines: string[] = []
  let cursor = 0
  for (const patch of chosen) {
    lines.push(...base.slice(cursor, patch.offset), ...patch.lines)
    cursor = patch.offset + patch.removed
  }
  lines.push(...base.slice(cursor))
  return lines
}

/** Line-only three-way merge. Any genuine or uncertain conflict aborts the entire document. */
export function mergeText(base: string, head: string, incoming: string): MergeResult {
  // Identical/unchanged documents need no diff, even above the complexity budget.
  if (head === incoming || base === incoming) return { text: head, clean: true }
  if (base === head) return { text: incoming, clean: true }
  const a = splitLines(head),
    o = splitLines(base),
    b = splitLines(incoming)
  const conflict = (): MergeResult => ({ text: head, clean: false, conflictCopy: true })
  // node-diff3's LCS visits every matching pair; bound it before it blocks the server.
  if (!linePassAllowed(o, a, b)) return conflict()
  const regions = diff3Merge(a, o, b, { excludeFalseConflicts: true })
  const lines: string[] = []
  for (const region of regions) {
    if (region.conflict) {
      const { a, o, b } = region.conflict
      const merged = mergeRegion(o, a, b)
      if (!merged) return conflict()
      for (const line of merged) lines.push(line)
    } else {
      for (const line of region.ok ?? []) lines.push(line)
    }
  }
  return { text: joinLines(lines, shapeForResult(base, head, incoming)), clean: true }
}
