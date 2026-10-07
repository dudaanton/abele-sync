import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { api } from './client.js'

/**
 * The moves a device makes against a vault, for the commit, history and
 * retention tests: upload bytes, commit a batch, describe a create.
 */

export const shaOf = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')

export const octet = { 'content-type': 'application/octet-stream' }

/** Upload bytes under their own sha; the sha comes back for the op that will name it. */
export async function putBlob(
  app: FastifyInstance,
  token: string,
  text: string | Buffer
): Promise<string> {
  const s = shaOf(text)
  const r = await api(app, token).raw({
    method: 'PUT',
    url: `/v1/blobs/${s}`,
    payload: Buffer.from(text),
    headers: octet,
  })
  // Always 201: whether the bytes were there already is never said.
  if (r.status !== 201) throw new Error(`put blob ${r.status}`)
  return s
}

/** Commit a batch and hand back the response body; anything but 200 is a test failure. */
export async function commit(
  app: FastifyInstance,
  token: string,
  vaultId: string,
  ops: unknown[]
): Promise<any> {
  const r = await api(app, token).post(`/v1/vaults/${vaultId}/commit`, { ops })
  if (r.status !== 200) throw new Error(`commit ${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

/** A create op for bytes already uploaded with `putBlob`. */
export const create = (path: string, text: string | Buffer, mtime = 1) => ({
  op: 'create' as const,
  path,
  sha: shaOf(text),
  size: Buffer.byteLength(text),
  mtime,
})
