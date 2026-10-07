import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runner = fileURLToPath(new URL('../../../../scripts/test-sql.mjs', import.meta.url))

describe('required SQL runner', () => {
  it('fails instead of reporting a skipped PG gate when the URL is absent', () => {
    const result = spawnSync(process.execPath, [runner], {
      env: { ...process.env, ABELE_TEST_PG_URL: '' },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('ABELE_TEST_PG_URL is required')
  })
  it('rejects a non-PostgreSQL URL before starting tests', () => {
    const result = spawnSync(process.execPath, [runner], {
      env: { ...process.env, ABELE_TEST_PG_URL: 'sqlite::memory:' },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('PostgreSQL URL is required')
  })
})
