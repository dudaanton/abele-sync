import { expect, it } from 'vitest'
import { canonicalCrashIdentifiers, canonicalCrashMetadata } from '../helpers/crashImage.js'

it.each([
  ['group-first', 'group-second', 'group-third', 'group-fourth'],
  [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
  ],
  ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)],
])('preserves distinct identifier references (%s)', (a, b, c, d) => {
  const normalized = canonicalCrashIdentifiers(JSON.stringify([a, a, b]))
  const values = JSON.parse(normalized)
  expect(values[0]).toBe(values[1])
  expect(values[0]).not.toBe(values[2])
  expect(normalized).toBe(canonicalCrashIdentifiers(JSON.stringify([c, c, d])))
})

const path = '.abele-sync/retained-removals/summary.json'
const day = 86400000
const metadata = (identity: string, capturedAt: number) =>
  JSON.stringify([{ capturedAt, expected: { identity, sha: 'content' }, phase: 'committed' }])

it('recognizes fresh retention images with identical inode relationships', () => {
  const a = canonicalCrashMetadata(
    path,
    metadata('1:2:3', 1000),
    new Map([['1:2:3', ['victim']]]),
    1100
  )
  const b = canonicalCrashMetadata(
    path,
    metadata('7:8:9', 2000),
    new Map([['7:8:9', ['victim']]]),
    2100
  )
  expect(a).toBe(b)
})

it('normalizes identity references in conditional intents as well as summaries', () => {
  const a = canonicalCrashMetadata(
    'intent.json',
    metadata('1:2:3', 1000),
    new Map([['1:2:3', ['victim', 'public']]]),
    1100
  )
  const b = canonicalCrashMetadata(
    'intent.json',
    metadata('7:8:9', 1000),
    new Map([['7:8:9', ['public', 'victim']]]),
    1100
  )
  expect(a).toBe(b)
  // Non-retention timestamps are not eligible for the protected-age abstraction.
  expect(a).not.toBe(
    canonicalCrashMetadata(
      'intent.json',
      metadata('7:8:9', 2000),
      new Map([['7:8:9', ['public', 'victim']]]),
      2100
    )
  )
})

it('keeps changed inode ownership and missing identity references distinct', () => {
  const data = metadata('1:2:3', 1000)
  const owned = canonicalCrashMetadata(path, data, new Map([['1:2:3', ['victim']]]), 1100)
  const other = canonicalCrashMetadata(path, data, new Map([['1:2:3', ['public']]]), 1100)
  const missing = canonicalCrashMetadata(path, data, new Map(), 1100)
  expect(owned).not.toBe(other)
  expect(owned).not.toBe(missing)
  expect(other).not.toBe(missing)
})

it.each([day - 120000, day, 7 * day, -1])(
  'preserves exact timestamps near or beyond a safety boundary (age=%s)',
  (age) => {
    const now = 8 * day
    const data = metadata('1:2:3', now - age)
    const result = canonicalCrashMetadata(path, data, new Map(), now)
    expect(JSON.parse(result)[0].capturedAt).toBe(now - age)
  }
)
