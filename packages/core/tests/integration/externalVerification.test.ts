import { describe, expect, it } from 'vitest'
import { createScopedClient } from '../../src/scopedClient.js'
import { encodeText, sha256 } from '../../src/hash.js'
import { serverHarness } from '../helpers/harness.js'

describe('external verification clients against real server routes', () => {
  it('uses personal live metadata and verifies the same version for a scoped reader', async () => {
    const h = await serverHarness({ scopedSharing: true })
    try {
      const owner = await h.account(),
        vault = (await h.vault(owner.accountToken)).vaultId
      const device = await h.device(owner.accountToken, vault),
        personal = h.clientFor(device.deviceToken, vault)
      const bytes = encodeText('attachment'),
        sha = await sha256(bytes)
      await personal.putBlob(sha, bytes)
      const file = (
        await personal.commit(
          [{ op: 'create', path: 'Agents/a.bin', sha, size: bytes.length, mtime: 1 }],
          'external-create'
        )
      ).results[0]!
      if (file.status !== 'applied') throw new Error('fixture did not create a live file')
      const head = await personal.head(file.file_id)
      const expected = {
        version_id: head.version_id,
        path: head.path,
        sha: head.sha,
        size: head.size,
      }
      expect(await personal.verifyExternalFile(file.file_id, expected)).toEqual({
        verified: true,
        file_id: head.file_id,
        ...expected,
      })
      const ownerPost = async (path: string, input: unknown) => {
        const res = await h.fetch(`https://issuer.example.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${owner.accountToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(input),
        })
        expect(res.status).toBe(201)
        return res.json()
      }
      const grant = await ownerPost(`/v1/vaults/${vault}/grants`, {
        label: 'Agents',
        prefix: 'Agents/',
        role: 'editor',
      })
      const key = await ownerPost(`/v1/vaults/${vault}/grants/${grant.id}/keys`, {
        attempt_id: 'reader',
        name: 'reader',
        role: 'reader',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })
      const scoped = await createScopedClient({
        baseUrl: 'https://issuer.example.test',
        fetch: h.fetch,
        token: key.key_token,
        vaultId: vault,
        grantId: grant.id,
        principalKind: 'key',
        principalId: key.key_id,
      })
      expect(await scoped.verifyExternalFile(file.file_id, expected)).toEqual({
        verified: true,
        file_id: head.file_id,
        ...expected,
      })
      await personal.commit(
        [{ op: 'delete', file_id: file.file_id, base_version_id: file.version_id }],
        'external-delete'
      )
      await expect(personal.verifyExternalFile(file.file_id, expected)).rejects.toMatchObject({
        code: 'not_found',
      })
      await expect(scoped.verifyExternalFile(file.file_id, expected)).rejects.toMatchObject({
        code: 'not_found',
      })
    } finally {
      await h.close()
    }
  })
})
