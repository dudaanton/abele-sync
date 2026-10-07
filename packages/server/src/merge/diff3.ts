import { diff3Merge } from 'node-diff3'
import DiffMatchPatch from 'diff-match-patch'

export interface MergeResult {
  text: string
  clean: boolean
  /** The line pass was not attempted; keep the inputs in separate files. */
  conflictCopy?: true
}

/**
 * The character pass must be deterministic and must not paper over a real conflict.
 * - Diff_Timeout 0: the default one second lets diff_main return a partial diff under load,
 *   so the same three inputs could merge differently on two runs.
 * - Match_Threshold 0 with an unbounded Match_Distance: a hunk applies only where its context
 *   occurs verbatim in head, at whatever position. The default fuzzy match (0.5) applies
 *   `title` → `title B` onto `title A` and reports a clean `title A B`.
 * - Patch_DeleteThreshold 0: a hunk whose pre-image is longer than Match_MaxBits (32) is a
 *   "monster delete" — patch_apply matches only its first and last 32 characters exactly and
 *   compares the middle against this threshold. At the default 0.5 a head edit inside a long
 *   deleted or rewritten span, more than 32 characters from either end, is thrown away with
 *   the flag true. At 0 the middle must match exactly too.
 * Patch_Margin keeps its default: four characters of context on each side of an edit.
 */
const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 0
dmp.Match_Threshold = 0
dmp.Match_Distance = Infinity
dmp.Patch_DeleteThreshold = 0

/**
 * Two bounds keep the character pass, which runs synchronously, from eating the server.
 * Per region: a side over MAX_CHAR_PASS_LINES lines or MAX_CHAR_PASS_BYTES of text is not
 * attempted — a whole-document conflict of a few thousand lines spent tens of seconds in
 * diff-match-patch to come out unclean anyway. Per document: every attempted region spends the
 * byte size of its three texts from CHAR_PASS_BUDGET_BYTES, in region order; the first region
 * that does not fit, and every region after it, is kept as both sides without an attempt. Without
 * the budget a document built as a hundred regions just under the per-region cap costs as much
 * as the whole-document conflict did. Either way the region falls back to head-then-incoming,
 * unclean.
 */
const MAX_CHAR_PASS_LINES = 64
const MAX_CHAR_PASS_BYTES = 4096
const CHAR_PASS_BUDGET_BYTES = 64 * 1024

/** How a document ends its lines and whether it ends with one. */
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

/**
 * The shape the merged text takes. Head's, except that an empty document has no shape, and
 * that a head which kept the base's shape yields to incoming — so that a side which only
 * changed the line ending or the trailing newline sees that edit survive the merge.
 */
function shapeForResult(base: string, head: string, incoming: string): LineShape {
  if (head === '') return shapeOf(incoming)
  if (incoming === '') return shapeOf(head)
  const headShape = shapeOf(head)
  return sameShape(headShape, shapeOf(base)) ? shapeOf(incoming) : headShape
}

/** The lines of a document with endings normalised; a trailing newline does not add an empty line. */
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

/** A region as text for diff-match-patch; every line newline-terminated so a whole-line edit is one hunk. */
const linesToText = (lines: string[]): string => lines.map((line) => line + '\n').join('')

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8')

/** The character-pass allowance of one document; see the bounds above. */
class CharPassBudget {
  private remaining = CHAR_PASS_BUDGET_BYTES
  private exhausted = false

  /** Whether this region may be attempted; when it may, its cost is spent. */
  allows(head: string, base: string, incoming: string): boolean {
    if (this.exhausted) return false
    const sides = [head, base, incoming]
    if (sides.some((text) => bytesOf(text) > MAX_CHAR_PASS_BYTES)) return false
    const cost = bytesOf(head) + bytesOf(base) + bytesOf(incoming)
    if (cost > this.remaining) {
      this.exhausted = true
      return false
    }
    this.remaining -= cost
    return true
  }
}

const tooManyLines = (...sides: string[][]): boolean =>
  sides.some((lines) => lines.length > MAX_CHAR_PASS_LINES)

/**
 * The character-level attempt at one conflict region: the base→incoming patch applied onto head.
 * Returns the merged lines when every hunk applied, null when any did not or none was made.
 *
 * A region with no base lines is never attempted: both sides inserted different text at the same
 * spot — the whole document, when the base is empty. A patch made from nothing has no context of
 * its own; patch_apply pads the region with Patch_Margin sentinel characters, so a hunk touching
 * the region's start or end is pinned to that edge and this one would land at the start, putting
 * incoming first. Nor is a region the bounds above rule out.
 */
function mergeRegionByCharacters(
  head: string[],
  base: string[],
  incoming: string[],
  budget: CharPassBudget
): string[] | null {
  if (base.length === 0) return null
  if (tooManyLines(head, base, incoming)) return null
  const [headText, baseText, incomingText] = [head, base, incoming].map(linesToText) as [
    string,
    string,
    string,
  ]
  if (!budget.allows(headText, baseText, incomingText)) return null
  const patches = dmp.patch_make(baseText, incomingText)
  const [text, applied] = dmp.patch_apply(patches, headText)
  return applied.every(Boolean) ? splitLines(text) : null
}

/**
 * Three-way merge of a note. Line-based diff3 first; each conflicting region gets a
 * character-level attempt, and when that fails the region keeps head's lines followed by
 * incoming's and the result is marked unclean. Line endings and the trailing newline follow
 * `shapeForResult`.
 */
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

export function mergeText(base: string, head: string, incoming: string): MergeResult {
  const a = splitLines(head),
    o = splitLines(base),
    b = splitLines(incoming)
  // node-diff3's LCS visits every matching pair of lines. Count those
  // pairs in linear time before calling it, not after it blocks the server.
  if (!linePassAllowed(o, a, b)) {
    return { text: head, clean: false, conflictCopy: true }
  }
  const regions = diff3Merge(a, o, b, {
    excludeFalseConflicts: true,
  })
  const budget = new CharPassBudget()
  const lines: string[] = []
  let clean = true
  for (const region of regions) {
    if (!region.conflict) {
      for (const line of region.ok ?? []) lines.push(line)
      continue
    }
    const { a, o, b } = region.conflict
    const merged = mergeRegionByCharacters(a, o, b, budget)
    if (merged) {
      for (const line of merged) lines.push(line)
    } else {
      for (const line of a) lines.push(line)
      for (const line of b) lines.push(line)
      clean = false
    }
  }
  return { text: joinLines(lines, shapeForResult(base, head, incoming)), clean }
}
