import { expect, it } from 'vitest'
import { sweepIdempotency } from '../../src/api/idempotency.js'
import { api } from '../helpers/client.js'
import { commit, create, putBlob } from '../helpers/ops.js'
import { buildTestApp } from '../helpers/testApp.js'

it('replays an old prefer-mine receipt after retention instead of replacing newer work', async () => {
  let now = new Date('2026-01-01T00:00:00Z')
  const t = await buildTestApp({ now: () => now })
  try {
    const { accountToken } = await t.account(),
      { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    await putBlob(t.app, deviceToken, 'old join choice')
    const request = {
      method: 'POST' as const,
      url: `/v1/vaults/${vaultId}/commit`,
      headers: { 'idempotency-key': 'lost-answer', 'content-type': 'application/json' },
      payload: JSON.stringify({ ops: [{ ...create('a.md', 'old join choice'), prefer: 'mine' }] }),
    }
    const first = await api(t.app, deviceToken).raw(request)
    const base = first.body.results[0]
    await putBlob(t.app, deviceToken, 'new work')
    await commit(t.app, deviceToken, vaultId, [
      {
        op: 'modify',
        file_id: base.file_id,
        base_version_id: base.version_id,
        ...Object.fromEntries(
          Object.entries(create('a.md', 'new work')).filter(
            ([key]) => !['op', 'path'].includes(key)
          )
        ),
      },
    ])
    now = new Date('2026-01-04T00:00:00Z')
    await sweepIdempotency(t.db, new Date('2026-01-03T00:00:00Z'))
    const replay = await api(t.app, deviceToken).raw(request)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.body).toEqual(first.body)
    const versions = await t.db.selectFrom('versions').select('id').execute()
    expect(versions).toHaveLength(2)
  } finally {
    await t.close()
  }
})
