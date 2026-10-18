import { mkdtemp, rm, readFile, readdir, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { selectiveDefaults, SyncEngine } from '@abele/sync-core'
import { encodeAccessToken } from '@abele/sync-protocol'
import {
  openNodeReplica,
  writeConfig,
  readConfig,
  acquireLock,
  SqliteStateStore,
  stateDbFile,
} from '../../src/index.js'

// A stable boot clock keeps these composition checks independent of host OS permissions.
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  uptime: () => 1000,
}))

const key = encodeAccessToken({
  v: 1,
  address: 'http://localhost:8787',
  key: 'a'.repeat(43),
  scope: { kind: 'folder', id: 'root', path: '/' },
})
const connection = {
  protocol: 2,
  token_id: 'd1',
  space_id: 'v1',
  scope: { kind: 'folder', id: 'root', path: '/' },
  status: 'active',
  limits: { max_file_bytes: 200 * 1024 * 1024, quota_bytes: null },
}

it('keeps durable state outside the folder and resumes on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-state-'))
  const dir = join(root, 'vault'),
    stateDir = join(root, 'state')
  const transport = vi.fn(async () => Response.json(connection))
  try {
    const replica = await openNodeReplica({ dir, stateDir, key, fetch: transport })
    try {
      await replica.state.setCursor(41)
      await replica.fs.writeAtomic('example.md', new TextEncoder().encode('hello'), 1000)
      expect(await readdir(stateDir)).toEqual(
        expect.arrayContaining(['config.json', 'state.db', 'lock'])
      )
      await expect(
        openNodeReplica({ dir, stateDir: join(root, 'other'), key, fetch: transport })
      ).rejects.toThrow(/another abele-sync/)
      await expect(
        openNodeReplica({ dir: join(root, 'second'), stateDir, key, fetch: transport })
      ).rejects.toThrow()
    } finally {
      replica.close()
    }
    expect(
      (await readdir(join(dir, '.abele-sync'))).filter(
        (name) => !['tmp', 'stages', 'code-approvals'].includes(name)
      )
    ).toEqual([])
    const reopened = await openNodeReplica({ dir, stateDir, key, fetch: transport })
    try {
      expect(await reopened.state.getCursor()).toBe(41)
      expect(transport).toHaveBeenCalledTimes(1)
    } finally {
      reopened.close()
    }
    await expect(
      openNodeReplica({ dir: join(root, 'second'), stateDir, key, fetch: transport })
    ).rejects.toThrow(/another directory/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses state directories inside the folder except the default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-nested-state-'))
  try {
    await expect(openNodeReplica({ dir, stateDir: join(dir, 'private'), key })).rejects.toThrow(
      /inside/
    )
    const replica = await openNodeReplica({
      dir,
      stateDir: join(dir, '.abele-sync'),
      key,
      fetch: async () => Response.json(connection),
    })
    replica.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('refuses a nested state directory reached through a symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-state-alias-'))
  try {
    await symlink(root, join(root, 'alias'))
    await expect(
      openNodeReplica({ dir: root, stateDir: join(root, 'alias', 'private'), key })
    ).rejects.toThrow(/inside/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('fences writes when the external state lock is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-state-claim-'))
  const stateDir = join(root, 'state')
  try {
    const replica = await openNodeReplica({
      dir: join(root, 'vault'),
      stateDir,
      key,
      fetch: async () => Response.json(connection),
    })
    try {
      await unlink(join(stateDir, 'lock'))
      await expect(async () =>
        replica.fs.writeAtomic('example.md', new Uint8Array(), 1000)
      ).rejects.toThrow(/claim/)
    } finally {
      replica.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('inspects recovery evidence in the external ledger before requesting or writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abele-state-safety-'))
  const options = { dir: join(root, 'vault'), stateDir: join(root, 'state'), key }
  try {
    const replica = await openNodeReplica({
      ...options,
      fetch: async () => Response.json(connection),
    })
    try {
      replica.state.setMeta('deferred-changes', JSON.stringify({ staged: [{}] }))
    } finally {
      replica.close()
    }
    const fetch = vi.fn(async () => {
      throw new Error('unexpected request')
    })
    await expect(openNodeReplica({ ...options, fetch })).rejects.toThrow(/malformed deferred queue/)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('opens a configured replica and builds an engine without CLI context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-replica-'))
  const config = {
    serverUrl: 'http://localhost:8787',
    deviceToken: encodeAccessToken({
      v: 1,
      address: 'http://localhost:8787',
      key: 'a'.repeat(43),
      scope: { kind: 'folder', id: 'root', path: '/' },
    }),
    vaultId: 'v1',
    deviceId: 'd1',
    deviceName: 'test',
    selective: selectiveDefaults(),
  }
  try {
    writeConfig(dir, config)
    const replica = openNodeReplica({
      dir,
      config,
      fetch: async () => {
        throw new Error('unexpected request')
      },
    })
    try {
      expect(replica.cfg).toEqual(config)
      expect(replica.buildEngine({ fallbackMs: 300_000, log() {} })).toBeInstanceOf(SyncEngine)
      expect(replica.filter.excluded('.git/config', 0)).toBe(true)
      expect(replica.filter.excluded('notes/example.md', 0)).toBe(false)
      await expect(replica.fs.writeAtomic('example.md', new Uint8Array(), 0)).rejects.toThrow(
        /owned vault lock/
      )
    } finally {
      replica.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('opens from a key, recovers before writes, and releases its owned lock on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-key-replica-'))
  const transport = vi.fn(async () => Response.json(connection))
  try {
    const replica = await openNodeReplica({ dir, key, fetch: transport })
    try {
      expect(transport).toHaveBeenCalledTimes(1)
      expect(readConfig(dir)?.deviceToken).toBe(key)
      await replica.fs.writeAtomic('example.md', new TextEncoder().encode('example'), 1000)
      expect(await readFile(join(dir, 'example.md'), 'utf8')).toBe('example')
      await expect(acquireLock(dir)).rejects.toThrow(/another abele-sync/)
    } finally {
      replica.close()
    }
    const lock = await acquireLock(dir)
    lock()
    replica.close()
    const reopened = await openNodeReplica({
      dir,
      key,
      fetch: async () => {
        throw new Error('unexpected request')
      },
    })
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('releases its lock after failed initialization and preserves a foreign ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-key-foreign-'))
  try {
    const state = SqliteStateStore.open(stateDbFile(dir))
    state.setMeta('token-connection', 'foreign')
    await state.setCursor(41)
    state.close()
    await expect(
      openNodeReplica({ dir, key, fetch: async () => Response.json(connection) })
    ).rejects.toThrow(/another connection ledger/)
    expect(readConfig(dir)).toBeNull()
    const lock = await acquireLock(dir)
    lock()
    const after = SqliteStateStore.open(stateDbFile(dir))
    try {
      expect(await after.getCursor()).toBe(41)
    } finally {
      after.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('validates supplied configuration before persisting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-invalid-config-'))
  try {
    const lock = await acquireLock(dir)
    try {
      expect(() =>
        openNodeReplica({
          dir,
          held: lock.held,
          config: {
            serverUrl: 'http://localhost:9999',
            deviceToken: key,
            vaultId: 'v1',
            deviceId: 'd1',
            deviceName: 'test',
            selective: selectiveDefaults(),
          },
        })
      ).toThrow(/stored token address mismatch/)
      expect(readConfig(dir)).toBeNull()
    } finally {
      lock()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
