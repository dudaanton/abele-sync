import { join } from 'node:path'
import { expect, it } from 'vitest'
import { UploadManager } from '../../src/blobs/uploads.js'
import { api } from '../helpers/client.js'
import { octet, shaOf } from '../helpers/ops.js'
import { buildTestApp } from '../helpers/testApp.js'

it('rolls back a completion claim interrupted before its blob was stored', async () => {
  const t = await buildTestApp({ partBytes: 1024 })
  try {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceToken } = await t.device(accountToken, vaultId)
    const bytes = Buffer.alloc(2048, 6)
    const sha = shaOf(bytes)
    const url = `/v1/blobs/${sha}/upload`
    const first = await api(t.app, deviceToken).post(url, { size: bytes.length })
    const id = first.body.upload_id
    await api(t.app, deviceToken).raw({
      method: 'PUT',
      url: `${url}/${id}/0`,
      headers: octet,
      payload: bytes.subarray(0, 1024),
    })
    await t.db
      .updateTable('uploads')
      .set({ completing_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
    const restarted = new UploadManager(
      t.db,
      t.store,
      join(t.dir, 'blobs', 'uploads'),
      1024,
      200_000_000
    )
    await restarted.recoverCompletions()
    expect(
      (
        await t.db
          .selectFrom('uploads')
          .select('completing_at')
          .where('id', '=', id)
          .executeTakeFirst()
      )?.completing_at
    ).toBeNull()
    expect((await api(t.app, deviceToken).post(url, { size: bytes.length })).body).toMatchObject({
      upload_id: id,
      received: [0],
    })
  } finally {
    await t.close()
  }
})

it('does not grant another vault a shared blob without verified parts of its own', async () => {
  const t = await buildTestApp({ partBytes: 1024 })
  try {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceId, deviceToken } = await t.device(accountToken, vaultId)
    const bytes = Buffer.alloc(2048, 7)
    const sha = shaOf(bytes)
    await t.store.put(bytes) // A different vault stored it; this device has no parts.
    const id = (
      await api(t.app, deviceToken).post(`/v1/blobs/${sha}/upload`, { size: bytes.length })
    ).body.upload_id
    await t.db
      .updateTable('uploads')
      .set({ completing_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
    const restarted = new UploadManager(
      t.db,
      t.store,
      join(t.dir, 'blobs', 'uploads'),
      1024,
      200_000_000
    )
    await restarted.recoverCompletions()
    expect(
      await t.db
        .selectFrom('blob_uploads')
        .select('sha')
        .where('device_id', '=', deviceId)
        .execute()
    ).toEqual([])
    expect(
      (
        await t.db
          .selectFrom('uploads')
          .select('completing_at')
          .where('id', '=', id)
          .executeTakeFirst()
      )?.completing_at
    ).toBeNull()
  } finally {
    await t.close()
  }
})

it('finishes an interrupted completion only after verifying its own parts', async () => {
  const t = await buildTestApp({ partBytes: 1024 })
  try {
    const { accountToken } = await t.account()
    const { vaultId } = await t.vault(accountToken)
    const { deviceId, deviceToken } = await t.device(accountToken, vaultId)
    const bytes = Buffer.alloc(2048, 7)
    const sha = shaOf(bytes)
    const id = (
      await api(t.app, deviceToken).post(`/v1/blobs/${sha}/upload`, { size: bytes.length })
    ).body.upload_id
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await api(t.app, deviceToken).raw({
            method: 'PUT',
            url: `/v1/blobs/${sha}/upload/${id}/${i}`,
            headers: octet,
            payload: bytes.subarray(i * 1024, (i + 1) * 1024),
          })
        ).status
      ).toBe(204)
    }
    await t.db
      .updateTable('uploads')
      .set({ completing_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute()
    const restarted = new UploadManager(
      t.db,
      t.store,
      join(t.dir, 'blobs', 'uploads'),
      1024,
      200_000_000
    )
    await restarted.recoverCompletions()
    expect(await t.db.selectFrom('uploads').select('id').where('id', '=', id).execute()).toEqual([])
    expect(
      await t.db
        .selectFrom('blob_uploads')
        .select('sha')
        .where('vault_id', '=', vaultId)
        .where('device_id', '=', deviceId)
        .execute()
    ).toEqual([{ sha }])
  } finally {
    await t.close()
  }
})
