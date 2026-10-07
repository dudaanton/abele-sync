import { describe, expect, it } from 'vitest'
import { ScopedCommitRequestSchema, ScopedCommitResponseSchema } from '../src/scopedCommits.js'
describe('v4 scoped commit wire', () => {
  it('bounds operations and refuses personal identity adoption or unknown fields', () => {
    const create = { op: 'create', path: 'Agents/new.md', sha: 'a'.repeat(64), size: 3, mtime: 1 }
    expect(
      ScopedCommitRequestSchema.safeParse({ request_id: 'durable', ops: [create] }).success
    ).toBe(true)
    for (const request of [
      { request_id: 'durable', ops: [{ ...create, prefer: 'mine' }] },
      { request_id: 'durable', ops: [{ ...create, actor: 'owner' }] },
      { request_id: 'durable', ops: Array.from({ length: 33 }, () => create) },
      { request_id: 'durable', ops: [create], head_seq: 1 },
    ])
      expect(ScopedCommitRequestSchema.safeParse(request).success).toBe(false)
  })
  it('has an explicit compact acknowledgement and never accepts personal sequences', () => {
    const result = {
      status: 'applied',
      file_id: 'file',
      version_id: 'version',
      path: 'Agents/new.md',
      sha: 'a'.repeat(64),
      size: 3,
      mtime: 1,
    }
    expect(
      ScopedCommitResponseSchema.safeParse({
        outcome_id: 'outcome',
        acknowledged: false,
        results: [result],
      }).success
    ).toBe(true)
    expect(
      ScopedCommitResponseSchema.safeParse({
        outcome_id: 'outcome',
        acknowledged: false,
        results: [{ ...result, seq: 1 }],
      }).success
    ).toBe(false)
    expect(
      ScopedCommitResponseSchema.safeParse({
        outcome_id: 'outcome',
        acknowledged: true,
        results: [],
      }).success
    ).toBe(true)
  })
})
