import { createHash } from 'node:crypto'
import { SyncClient } from '@abele/sync-core'
import { expect } from 'vitest'
import { cli, clientFor, EMAIL, folder, PASSWORD, syncOnce, touch, write } from './folders.js'
import type { SpawnedServer } from './spawnServer.js'

/**
 * What the join suites share: `init` into a vault that already holds files. The server allows ten logins a minute, and every `init` is one, so the suites
 * are split three ways, each on a server of its own.
 */

export const env = { ABELE_PASSWORD: PASSWORD }

export const initArgs = (
  server: SpawnedServer,
  dir: string,
  vault: string,
  name: string,
  extra: string[] = []
): string[] => [
  'init',
  '--server',
  server.url,
  '--dir',
  dir,
  '--email',
  EMAIL,
  '--vault',
  vault,
  '--device-name',
  name,
  ...extra,
]

/** How many devices the account has on the named vault, asked with the account. One login. */
export async function devicesOn(server: SpawnedServer, vault: string): Promise<number> {
  const { account_token } = await SyncClient.login(server.url, fetch, EMAIL, PASSWORD)
  const client = new SyncClient({ baseUrl: server.url, fetch, token: account_token })
  const found = (await client.listVaults()).find((v) => v.name === vault)
  if (found === undefined) return 0
  return (await client.listDevices()).filter((d) => d.vault_id === found.id).length
}

/**
 * A vault the laptop filled — a note, an older image, a note of its own — and a second folder
 * with its own versions of the first two, a newer image, one note of its own, and nothing
 * synced. One login.
 */
export async function filledPair(
  server: SpawnedServer,
  vault: string
): Promise<{ laptop: string; joiner: string }> {
  const laptop = await folder()
  await write(laptop, 'Both.md', 'laptop text\n')
  await write(laptop, 'pic.png', 'laptop image, older')
  await touch(laptop, 'pic.png', 1_000_000)
  await write(laptop, 'Laptop only.md', 'from the laptop\n')
  const made = await cli(initArgs(server, laptop, vault, 'laptop'), env)
  expect(made.code, made.all).toBe(0)
  await syncOnce(laptop)

  const joiner = await folder()
  await write(joiner, 'Both.md', 'joiner text\n')
  await write(joiner, 'pic.png', 'joiner image, newer')
  await touch(joiner, 'pic.png', 2_000_000)
  await write(joiner, 'Joiner only.md', 'from the joiner\n')
  return { laptop, joiner }
}

async function itemAt(dir: string, path: string) {
  const item = (await clientFor(dir).manifest(null)).items.find((i) => i.path === path)
  if (item === undefined) throw new Error(`${path} is not on the server`)
  return item
}

/** Every sha the history of the file at `path` holds, on the folder's own token. */
export async function historyShas(dir: string, path: string): Promise<string[]> {
  const versions = await clientFor(dir).versions((await itemAt(dir, path)).file_id)
  return versions.flatMap((v) => (v.sha === null ? [] : [v.sha]))
}

/** The server's head of the file at `path`, as text. */
export async function serverText(dir: string, path: string): Promise<string> {
  const { sha } = await itemAt(dir, path)
  if (sha === null) throw new Error(`${path} has no bytes`)
  return Buffer.from(await clientFor(dir).getBlob(sha)).toString('utf8')
}

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
