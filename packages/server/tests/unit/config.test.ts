import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config.js'

const base = { ABELE_MASTER_KEY: 'ab'.repeat(32), ABELE_TOKEN_PEPPER: 'pepper' }

describe('loadConfig', () => {
  it('uses defaults', () => {
    const c = loadConfig(base)
    expect(c.databaseUrl).toBe('sqlite://data/abele.db')
    expect(c.port).toBe(8787)
    expect(c.maxFileBytes).toBe(200 * 1024 * 1024)
    expect(c.simpleUploadBytes).toBe(8 * 1024 * 1024)
    expect(c.partBytes).toBe(8 * 1024 * 1024)
    expect(c.masterKey).toHaveLength(32)
    expect(c.wsHelloTimeoutMs).toBe(5000)
    expect(c.trustProxy).toBe(false)
  })
  it('enables the entire scoped runtime only with an explicit on setting', () => {
    expect(loadConfig(base).scopedSharing).toBe(false)
    expect(loadConfig({ ...base, ABELE_SCOPED_SHARING: 'off' }).scopedSharing).toBe(false)
    expect(loadConfig({ ...base, ABELE_SCOPED_SHARING: 'on' }).scopedSharing).toBe(true)
    for (const value of ['', 'true', 'ON', 'folder', ' on '])
      expect(() => loadConfig({ ...base, ABELE_SCOPED_SHARING: value })).toThrow(
        /ABELE_SCOPED_SHARING must be on or off/
      )
  })
  it('reads the proxies to trust: none, all, or a list', () => {
    expect(loadConfig({ ...base, ABELE_TRUST_PROXY: 'false' }).trustProxy).toBe(false)
    expect(loadConfig({ ...base, ABELE_TRUST_PROXY: '' }).trustProxy).toBe(false)
    expect(loadConfig({ ...base, ABELE_TRUST_PROXY: 'true' }).trustProxy).toBe(true)
    expect(loadConfig({ ...base, ABELE_TRUST_PROXY: 'TRUE' }).trustProxy).toBe(true)
    expect(
      loadConfig({ ...base, ABELE_TRUST_PROXY: '10.0.0.0/8, 172.16.0.1,' }).trustProxy
    ).toEqual(['10.0.0.0/8', '172.16.0.1'])
  })
  it('registers bounded literal alternative configuration roots without allowing a scoped override', () => {
    expect(loadConfig(base).configurationDirectories).toEqual(['.obsidian'])
    expect(
      loadConfig({ ...base, ABELE_CONFIGURATION_DIRS: '["Config",".obsidian-work"]' })
        .configurationDirectories
    ).toEqual(['.obsidian', 'config', '.obsidian-work'])
    for (const raw of [
      'not-json',
      '["../Config"]',
      '[""]',
      'false',
      '["Config/"]',
      JSON.stringify(Array.from({ length: 17 }, (_, i) => `Config-${i}`)),
    ]) {
      expect(() => loadConfig({ ...base, ABELE_CONFIGURATION_DIRS: raw })).toThrow(
        /ABELE_CONFIGURATION_DIRS/
      )
    }
  })
  it('requires the master key and pepper', () => {
    expect(() => loadConfig({})).toThrow(/ABELE_MASTER_KEY/)
    expect(() => loadConfig({ ABELE_MASTER_KEY: 'ab'.repeat(32) })).toThrow(/ABELE_TOKEN_PEPPER/)
    expect(() => loadConfig({ ...base, ABELE_MASTER_KEY: 'short' })).toThrow(/64 hex/)
  })
  it('rejects a port that is not a plain number in range', () => {
    expect(() => loadConfig({ ...base, ABELE_PORT: '0x1F' })).toThrow(
      /ABELE_PORT must be an integer between 1 and 65535/
    )
    expect(() => loadConfig({ ...base, ABELE_PORT: '70000' })).toThrow(
      /ABELE_PORT must be an integer between 1 and 65535/
    )
  })
})
