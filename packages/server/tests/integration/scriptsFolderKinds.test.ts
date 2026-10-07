import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api } from '../helpers/client.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { buildTestApp, type TestApp } from '../helpers/testApp.js'

/**
 * A file's current kind is stored with it (`files.kind`) and read by usage and the manifest.
 * Retention reads each version's immutable class instead. Which `.js` files are scripts is the vault's `scripts_folder`, so moving that
 * folder re-kinds the files already there, in the same transaction as the setting — not one by
 * one as each is next written.
 */
describe('changing the scripts folder', () => {
  let t: TestApp
  beforeEach(async () => {
    t = await buildTestApp()
  })
  afterEach(async () => {
    await t.close()
  })

  it('re-kinds the files already in the vault at once', async () => {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const tok = (await t.device(accountToken, vaultId)).deviceToken
    for (const text of ['old script', 'new script', 'a note']) await putBlob(t.app, tok, text)
    await commit(t.app, tok, vaultId, [
      create('Scripts/a.js', 'old script'),
      create('NewScripts/b.js', 'new script'),
      create('note.md', 'a note'),
    ])
    const kinds = async (): Promise<Record<string, string>> => {
      const rows = await t.db
        .selectFrom('files')
        .select(['path', 'kind'])
        .where('vault_id', '=', vaultId)
        .execute()
      return Object.fromEntries(rows.map((row) => [row.path, row.kind]))
    }
    expect(await kinds()).toEqual({
      'Scripts/a.js': 'script',
      'NewScripts/b.js': 'attachment',
      'note.md': 'note',
    })

    const patched = await api(t.app, tok).patch(`/v1/vaults/${vaultId}/settings`, {
      scripts_folder: 'NewScripts',
    })
    expect(patched.status).toBe(200)
    expect(await kinds()).toEqual({
      'Scripts/a.js': 'attachment',
      'NewScripts/b.js': 'script',
      'note.md': 'note',
    })
    const usage = (await api(t.app, tok).get(`/v1/vaults/${vaultId}/usage`)).body
    expect(usage.by_kind.script.count).toBe(1)
    expect(usage.by_kind.attachment.count).toBe(1)
  })
})
