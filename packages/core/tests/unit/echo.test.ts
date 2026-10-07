import { beforeEach, describe, expect, it } from 'vitest'
import { EngineError, ExpectedWrites } from '../../src/index.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

describe('ExpectedWrites', () => {
  let expected: ExpectedWrites

  beforeEach(() => {
    expected = new ExpectedWrites()
  })

  it('consumes an expected write exactly once', () => {
    expected.expect('notes/a.md', SHA_A)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(true)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(false)
  })

  it('is false for a pair nobody expected', () => {
    expect(expected.consume('notes/a.md', SHA_A)).toBe(false)
  })

  it('matches on the sha as well as the path', () => {
    expected.expect('notes/a.md', SHA_A)
    expect(expected.consume('notes/a.md', SHA_B)).toBe(false)
    expect(expected.consume('notes/b.md', SHA_A)).toBe(false)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(true)
  })

  it('counts repeated expectations of the same pair', () => {
    expected.expect('notes/a.md', SHA_A)
    expected.expect('notes/a.md', SHA_A)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(true)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(true)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(false)
  })

  it('keeps expectations for different shas at one path apart', () => {
    expected.expect('notes/a.md', SHA_A)
    expected.expect('notes/a.md', SHA_B)
    expect(expected.consume('notes/a.md', SHA_B)).toBe(true)
    expect(expected.consume('notes/a.md', SHA_B)).toBe(false)
    expect(expected.consume('notes/a.md', SHA_A)).toBe(true)
  })

  it('clears every expectation at a path and leaves other paths alone', () => {
    expected.expect('notes/a.md', SHA_A)
    expected.expect('notes/a.md', SHA_B)
    expected.expect('notes/b.md', SHA_A)
    expected.clear('notes/a.md')
    expect(expected.consume('notes/a.md', SHA_A)).toBe(false)
    expect(expected.consume('notes/a.md', SHA_B)).toBe(false)
    expect(expected.consume('notes/b.md', SHA_A)).toBe(true)
  })

  it('says whether anything is expected at a path', () => {
    expect(expected.has('notes/a.md')).toBe(false)
    expected.expect('notes/a.md', SHA_A)
    expect(expected.has('notes/a.md')).toBe(true)
    expect(expected.has('notes/b.md')).toBe(false)
    expected.consume('notes/a.md', SHA_A)
    expect(expected.has('notes/a.md')).toBe(false)
    expected.expect('notes/a.md', SHA_B)
    expected.clear('notes/a.md')
    expect(expected.has('notes/a.md')).toBe(false)
  })

  it('clearing an unknown path is not an error', () => {
    expect(() => expected.clear('nope.md')).not.toThrow()
  })
})

describe('EngineError', () => {
  it('carries its code, message and cause', () => {
    const cause = new Error('socket hang up')
    const error = new EngineError('offline', 'the server is unreachable', cause)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EngineError')
    expect(error.code).toBe('offline')
    expect(error.message).toBe('the server is unreachable')
    expect(error.cause).toBe(cause)
  })

  it('leaves the cause undefined when none is given', () => {
    expect(new EngineError('protocol', 'bad envelope').cause).toBeUndefined()
  })
})
