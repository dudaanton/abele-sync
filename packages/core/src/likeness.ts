import { kindOf } from '@abele/sync-protocol'

/**
 * Whether a lost file and a fresh one are the same file, renamed and edited — the one pairing
 * the scanner makes on content other than an equal sha (ruling 2026-09-27).
 *
 * Only notes are compared: a canvas or a note is text whose lines survive an edit, and at least
 * half of them must be shared, counted as a multiset over the longer of the two so that a note
 * of three lines is not "like" one of three hundred that happens to contain them. Blank lines
 * are left out of both sides; they are in every note and say nothing. Anything else — pictures,
 * PDFs, settings, scripts — is never paired without an equal sha: bytes that differ say nothing
 * about whether one became the other.
 */

/** The share of lines two versions of one note must have in common, at least. */
export const SHARED_LINES = 0.5

/** Whether a path is a note whose text can be compared at all. */
export function comparable(path: string): boolean {
  const kind = kindOf(path, '')
  return kind === 'note' || kind === 'canvas'
}

/** Whether `before` and `after` share at least `SHARED_LINES` of their lines. */
export function alike(before: Uint8Array, after: Uint8Array): boolean {
  const a = linesOf(before)
  const b = linesOf(after)
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return false
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let shared = 0
  for (const line of b) {
    const left = counts.get(line) ?? 0
    if (left === 0) continue
    counts.set(line, left - 1)
    shared += 1
  }
  return shared >= SHARED_LINES * longest
}

const decoder = new TextDecoder()

/** The lines that carry something, trailing whitespace and a `\r` aside. */
function linesOf(bytes: Uint8Array): string[] {
  return decoder
    .decode(bytes)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
}
