import type { CommitOp, CommitResponse } from '@abele/sync-protocol'
import { encodeText, sha256, type VaultClient } from '../../src/index.js'
import { BASE_URL, type Harness } from './harness.js'

/**
 * What a scenario does to a vault beside the devices under test: seeding files through a
 * client of its own, and reading what the server holds. None of this traffic is a device's.
 */

/** Bytes under the name they hash to, uploaded so a seeding commit may name them. */
export async function blob(
  client: VaultClient,
  content: string | Uint8Array
): Promise<{ sha: string; size: number }> {
  const bytes = typeof content === 'string' ? encodeText(content) : content
  const sha = await sha256(bytes)
  await client.putBlob(sha, bytes)
  return { sha, size: bytes.length }
}

/** A create op for bytes already uploaded with `blob`. */
export const create = async (
  client: VaultClient,
  path: string,
  content: string | Uint8Array,
  mtime = 1
): Promise<CommitOp> => ({ op: 'create', path, ...(await blob(client, content)), mtime })

let seeds = 0

/** One commit under a key of its own; anything the server refused is a scenario's mistake. */
export async function seed(client: VaultClient, ops: CommitOp[]): Promise<CommitResponse> {
  const response = await client.commit(ops, `scenario-seed-${++seeds}`)
  for (const result of response.results) {
    if (result.status === 'rejected') throw new Error(`seed refused: ${result.message}`)
  }
  return response
}

/** The vault's conflict mode, set through the settings route on a device token. */
export async function setConflictMode(
  h: Harness,
  deviceToken: string,
  vaultId: string,
  conflict: 'merge' | 'conflict-file'
): Promise<void> {
  const response = await h.fetch(`${BASE_URL}/v1/vaults/${vaultId}/settings`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${deviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conflict }),
  })
  if (response.status !== 200) throw new Error(`settings answered ${response.status}`)
}

export const shaOf = (content: string | Uint8Array): Promise<string> =>
  sha256(typeof content === 'string' ? encodeText(content) : content)
