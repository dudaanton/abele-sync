import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupFolders,
  config,
  EMAIL,
  listing,
  manifestPaths,
  PASSWORD,
  read,
  setSelective,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
} from './helpers/folders.js'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'

/**
 * Obsidian's own folder between two folders: the settings a person means to share travel,
 * the workspace never does, and a plugin's data only when both sides have asked for it.
 */

let server: SpawnedServer
let a: string
let b: string

beforeAll(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
  const pair = await vaultPair(server, 'Settings')
  a = pair.a
  b = pair.b
}, SETUP_MS)

afterAll(async () => {
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

/** Both sides on the defaults, where every settings switch is on. */
const pluginSettings = (dir: string, on: boolean): void =>
  setSelective(dir, { settings: { ...config(dir).selective.settings, pluginSettings: on } })

describe('.obsidian', () => {
  it('round-trips app.json and never carries workspace.json', async () => {
    await write(a, '.obsidian/app.json', '{"readableLineLength":true}\n')
    await write(a, '.obsidian/workspace.json', '{"main":{"id":"laptop-only"}}\n')
    await write(a, '.obsidian/plugins/x/data.json', '{"x":1}\n')
    await syncOnce(a)
    await syncOnce(b)
    expect(await listing(b)).toEqual(['.obsidian/app.json', '.obsidian/plugins/x/data.json'])
    expect(await read(b, '.obsidian/app.json')).toBe('{"readableLineLength":true}\n')
    expect(await manifestPaths(a)).not.toContain('.obsidian/workspace.json')

    // And back: B's edit to app.json lands in A.
    await write(b, '.obsidian/app.json', '{"readableLineLength":false}\n')
    await syncOnce(b)
    await syncOnce(a)
    expect(await read(a, '.obsidian/app.json')).toBe('{"readableLineLength":false}\n')
    expect(await read(a, '.obsidian/workspace.json')).toBe('{"main":{"id":"laptop-only"}}\n')
    expect(await listing(b)).not.toContain('.obsidian/workspace.json')
  })

  it('carries plugin data only when both sides have pluginSettings on', async () => {
    // B off: A uploads the plugin's data, B leaves it on the server.
    pluginSettings(b, false)
    await write(a, '.obsidian/plugins/y/data.json', '{"y":1}\n')
    await syncOnce(a)
    await syncOnce(b)
    expect(await manifestPaths(a)).toContain('.obsidian/plugins/y/data.json')
    expect(await listing(b)).not.toContain('.obsidian/plugins/y/data.json')

    // A off, B on: A never uploads, so there is nothing for B to fetch — and B, switched on
    // again, goes back for the data it passed over.
    pluginSettings(a, false)
    pluginSettings(b, true)
    await write(a, '.obsidian/plugins/z/data.json', '{"z":1}\n')
    await syncOnce(a)
    await syncOnce(b)
    expect(await manifestPaths(a)).not.toContain('.obsidian/plugins/z/data.json')
    expect(await listing(b)).not.toContain('.obsidian/plugins/z/data.json')
    expect(await read(b, '.obsidian/plugins/y/data.json')).toBe('{"y":1}\n')
  })
})
