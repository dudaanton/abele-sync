import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { cli, clientFor, folder, syncOnce, touch, write } from './folders.js'
import type { SpawnedServer } from './spawnServer.js'

/** First-connect fixtures use independently issued tokens into a named synthetic space. */
export const connectArgs = (
  server: SpawnedServer,
  dir: string,
  space: string,
  name: string
): string[] => ['connect', '--dir', dir, '--token', server.tokenFor(space, name)]

export async function filledPair(
  server: SpawnedServer,
  space: string
): Promise<{ laptop: string; joiner: string }> {
  const laptop = await folder()
  await write(laptop, 'Both.md', 'laptop text\n')
  await write(laptop, 'pic.png', 'laptop image, older')
  await touch(laptop, 'pic.png', 1_000_000)
  await write(laptop, 'Laptop only.md', 'from the laptop\n')
  const made = await cli(connectArgs(server, laptop, space, 'laptop'))
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
  if (!item) throw new Error(`${path} is not on the server`)
  return item
}
export async function historyShas(dir: string, path: string): Promise<string[]> {
  return (await clientFor(dir).versions((await itemAt(dir, path)).file_id)).flatMap((v) =>
    v.sha === null ? [] : [v.sha]
  )
}
export async function serverText(dir: string, path: string): Promise<string> {
  const { sha } = await itemAt(dir, path)
  if (!sha) throw new Error(`${path} has no bytes`)
  return Buffer.from(await clientFor(dir).getBlob(sha)).toString('utf8')
}
export const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
