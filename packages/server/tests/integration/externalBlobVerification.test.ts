import { createCipheriv, hkdfSync } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { shaOf } from '../helpers/ops.js'

describe('streamed external blob verification', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('content'), Buffer.alloc(1024 * 1024, 7)])
    it(`BUG: returns authenticated actual byte count for ${bytes.length} bytes`, async () => {
      const t = await buildTestApp()
      try {
        const sha = shaOf(bytes)
        expect(await t.store.verify(sha)).toBeNull()
        await t.store.put(bytes)
        expect(await t.store.verify(sha)).toEqual({ sha, size: bytes.length })
        expect(await t.store.intact(sha)).toBe(true)
      } finally {
        await t.close()
      }
    })
  it('BUG: rejects valid GCM content whose SHA differs from the envelope name', async () => {
    const t = await buildTestApp()
    try {
      const sha = shaOf('right')
      await t.store.put(Buffer.from('right'))
      const key = Buffer.from(
        hkdfSync('sha256', Buffer.from('ab'.repeat(32), 'hex'), 'abele-blob', sha, 32)
      )
      const nonce = Buffer.alloc(12, 1),
        cipher = createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([cipher.update(Buffer.from('wrong')), cipher.final()])
      await writeFile(
        t.store.pathFor(sha),
        Buffer.concat([Buffer.from('ABS1'), nonce, body, cipher.getAuthTag()])
      )
      expect(await t.store.verify(sha)).toBeNull()
      expect(await t.store.intact(sha)).toBe(false)
    } finally {
      await t.close()
    }
  })
})
