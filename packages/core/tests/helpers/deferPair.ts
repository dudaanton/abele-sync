import { expect } from 'vitest'
import type { VaultClient } from '../../src/index.js'
import type { Harness } from './harness.js'
import { Device } from './device.js'
import { create, seed } from './seed.js'

/** The plugin's rule, near enough: everything in the config folder is staged. */
export const CONFIG = (path: string): boolean => path.startsWith('.obsidian/')
export const APP = '.obsidian/app.json'
export const PLUGIN = '.obsidian/plugins/p'

export interface Pair {
  vaultId: string
  /** The device that stages. */
  a: Device
  /** Another device of the vault, which does not. */
  b: Device
  seeder: VaultClient
}

/** A vault with a note, the app settings and a plugin, synced down to both devices. */
export async function pairOf(
  h: Harness,
  account: string,
  label: string,
  extra: Record<string, string> = {}
): Promise<Pair> {
  const { vaultId } = await h.vault(account, label)
  const { deviceToken: seederToken } = await h.device(account, vaultId, 'seeder')
  const seeder = h.clientFor(seederToken, vaultId)
  const files: Record<string, string> = {
    'Note.md': 'a note\n',
    [APP]: '{"a":1}',
    [`${PLUGIN}/main.js`]: 'main()',
    [`${PLUGIN}/manifest.json`]: '{"id":"p"}',
    [`${PLUGIN}/styles.css`]: 'p {}',
    ...extra,
  }
  const ops = []
  for (const [path, text] of Object.entries(files)) ops.push(await create(seeder, path, text))
  await seed(seeder, ops)
  const a = new Device(h, vaultId, (await h.device(account, vaultId, 'A')).deviceToken, 'A', {
    defer: CONFIG,
  })
  const b = new Device(h, vaultId, (await h.device(account, vaultId, 'B')).deviceToken, 'B')
  // A syncs a vault before any settings are staged, then has them written, as a first join does.
  await a.sync()
  await a.engine.applyDeferred()
  await b.sync()
  expect(await a.text(APP)).toBe('{"a":1}')
  return { vaultId, a, b, seeder }
}

/** The server's live file at a path. */
export async function head(client: VaultClient, path: string) {
  return (await client.manifest(null)).items.find((item) => item.path === path)
}
