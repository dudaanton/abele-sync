import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import SqliteDatabase, { type Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Core from '@abele/sync-core'
import { SqliteStateStore } from '../../src/sqliteState.js'

const binding = {
  endpoint: 'https://sync.example.invalid',
  vaultId: 'vault',
  mode: 'personal' as const,
  principalId: 'device',
  principalType: 'device' as const,
  grantId: null,
  generation: 1,
  credentialAssociation: 'credential-slot',
}
const expected = {
  fileId: 'file',
  versionId: 'version',
  path: 'Media/a.jpg',
  sha: 'a'.repeat(64),
  size: 10,
}
const base = { ...expected, mtime: 1000 }
const entry = {
  path: expected.path,
  wirePath: expected.path,
  fileId: expected.fileId,
  versionId: expected.versionId,
  sha: expected.sha,
  size: expected.size,
  mtime: base.mtime,
}
const operation = () => ({
  schema: 1 as const,
  operationId: 'operation',
  kind: 'eviction' as const,
  phase: 'prepared' as const,
  revision: 0,
  connectionGeneration: 1,
  expected,
  sourcePath: expected.path,
  targetPath: expected.path + '.abele-ref',
  previousRepresentation: 'hydrated' as const,
  localBase: base,
  desiredRepresentation: 'remote-only' as const,
  projectionDigest: 'b'.repeat(64),
  ownedArtifacts: [],
  unresolvedOutcome: null,
  cleanupReason: null,
})
const record = () => ({
  schema: 1 as const,
  ledgerId: 'ledger',
  binding,
  fileId: expected.fileId,
  representation: 'hydrated' as const,
  preference: 'on-demand' as const,
  pinned: false,
  projectionPath: null,
  projectionSha: null,
  localRevision: 0,
  pendingOperationId: 'operation',
  availability: 'active' as const,
  blockingReason: null,
  lastProvenLocalBase: base,
  retained: [],
})
const document = (revision: number) => ({
  schema: 1,
  ledgerId: 'ledger',
  binding,
  revision,
  files: [],
  operations: [],
})

let dir: string, file: string, store: SqliteStateStore
beforeEach(async () => {
  const scratch = resolve(import.meta.dirname, '../../../../.scratch')
  await mkdir(scratch, { recursive: true })
  dir = await mkdtemp(join(scratch, 'cli-external-'))
  file = join(dir, 'ledger.db')
  store = SqliteStateStore.open(file)
})
afterEach(async () => {
  vi.restoreAllMocks()
  store.close()
  await rm(dir, { recursive: true, force: true })
})
function reopen() {
  store.close()
  store = SqliteStateStore.open(file)
  return store
}
const open = () => Core.ExternalState.open(store, 'ledger', binding)

describe('external phases through the real CLI ledger connection', () => {
  it('BUG: exposes the durable external port and migrates a legacy ledger without replacing ordinary state', async () => {
    await store.put(entry)
    await store.setCursor(3)
    const journal = {
      batchId: 'batch',
      ops: [],
      idempotencyKey: 'key',
      startedAt: '2030-01-01T00:00:00.000Z',
    }
    await store.setJournal(journal)
    store.setMeta('ordinary', 'preserved')
    expect(store.externalDurability).toBe('durable')
    expect(await store.getExternalState()).toBeNull()
    const state = await open()
    expect((await state.snapshot()).revision).toBe(0)
    reopen()
    expect(await store.get(entry.path)).toEqual(entry)
    expect(await store.getCursor()).toBe(3)
    expect(await store.getJournal()).toEqual(journal)
    expect(store.getMeta('ordinary')).toBe('preserved')
    expect(JSON.parse((await store.getExternalState())!).schema).toBe(1)
    const raw = new SqliteDatabase(file, { readonly: true })
    try {
      expect(
        raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      ).toEqual([{ name: 'entries' }, { name: 'meta' }])
    } finally {
      raw.close()
    }
  })
  it('BUG: reopens committed phases, representation, retained ownership and earlier local base with atomic ledger progress', async () => {
    const state = await open()
    expect(
      await state.commit({
        expectedRevision: 0,
        files: [{ expectedRevision: null, next: record() }],
        operations: [{ expectedRevision: null, next: operation() }],
        ledger: {
          putEntries: [entry],
          cursor: 7,
          metadata: [{ key: 'checkpoint', value: 'before' }],
        },
      })
    ).toEqual({ status: 'committed', revision: 1 })
    const next = {
      ...record(),
      localRevision: 1,
      representation: 'remote-only' as const,
      projectionPath: operation().targetPath,
      projectionSha: 'b'.repeat(64),
      retained: [
        {
          path: 'Recovery/a.bin',
          sha: 'c'.repeat(64),
          size: 9,
          role: 'retained' as const,
          operationId: 'operation',
        },
      ],
    }
    const op = { ...operation(), revision: 1, phase: 'delete-ready' as const }
    const advanced = { ...entry, versionId: 'version-2', sha: 'd'.repeat(64) }
    const receipt = await state.commit({
      expectedRevision: 1,
      files: [{ expectedRevision: 0, next }],
      operations: [{ expectedRevision: 0, next: op }],
      ledger: {
        putEntries: [advanced],
        cursor: 8,
        metadata: [{ key: 'checkpoint', value: 'after' }],
      },
    })
    expect(receipt).toEqual({ status: 'committed', revision: 2 })
    reopen()
    const snapshot = await (await open()).snapshot()
    expect(snapshot.files).toEqual([next])
    expect(snapshot.operations).toEqual([op])
    expect(snapshot.files[0]!.lastProvenLocalBase).toEqual(base)
    expect(await store.byFileId(entry.fileId)).toEqual(advanced)
    expect(await store.getCursor()).toBe(8)
    expect(store.getMeta('checkpoint')).toBe('after')
  })
  it('BUG: rejects nesting in the CLI transaction even before its outer callback resumes', async () => {
    const state = await open(),
      effect = vi.fn()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const outer = store.transaction(async () => {
      await expect(state.commit({ expectedRevision: 0 })).rejects.toMatchObject({
        reason: 'nested-transaction',
      })
      await held
    })
    try {
      await expect(state.commit({ expectedRevision: 0 }).then(effect)).rejects.toMatchObject({
        reason: 'nested-transaction',
      })
    } finally {
      release()
      await outer
    }
    expect(effect).not.toHaveBeenCalled()
    reopen()
    expect((await (await open()).snapshot()).revision).toBe(0)
  })
  it('BUG: an actual statement abort rolls back ledger deletes/puts, cursor, metadata and phase without a receipt', async () => {
    const state = await open()
    await store.put(entry)
    await store.setCursor(3)
    store.setMeta('checkpoint', 'before')
    const raw = new SqliteDatabase(file)
    try {
      raw.exec(
        "CREATE TRIGGER reject_phase BEFORE UPDATE ON meta WHEN NEW.key = 'daemon:external-files' BEGIN SELECT RAISE(ABORT, 'test abort'); END;"
      )
    } finally {
      raw.close()
    }
    const effect = vi.fn()
    await expect(
      state
        .commit({
          expectedRevision: 0,
          operations: [{ expectedRevision: null, next: operation() }],
          ledger: {
            deletePaths: [entry.path],
            putEntries: [{ ...entry, path: 'Media/b.jpg', wirePath: 'Media/b.jpg' }],
            cursor: 9,
            metadata: [{ key: 'checkpoint', value: 'after' }],
          },
        })
        .then(effect)
    ).rejects.toMatchObject({ reason: 'aborted' })
    expect(effect).not.toHaveBeenCalled()
    reopen()
    expect((await (await open()).snapshot()).operations).toEqual([])
    expect(await store.byFileId(entry.fileId)).toEqual(entry)
    expect(await store.getCursor()).toBe(3)
    expect(store.getMeta('checkpoint')).toBe('before')
  })
  for (const landed of [false, true])
    it(`BUG: unknown COMMIT (${landed ? 'landed' : 'not landed'}) poisons the own-connection adapter until reopen`, async () => {
      const state = await open(),
        exec = SqliteDatabase.prototype.exec,
        effect = vi.fn()
      vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(function (this: Database, sql) {
        if (sql === 'COMMIT') {
          if (landed) exec.call(this, sql)
          throw new Error('commit acknowledgement unavailable')
        }
        return exec.call(this, sql)
      })
      await expect(
        state
          .commit({
            expectedRevision: 0,
            operations: [{ expectedRevision: null, next: operation() }],
            ledger: { putEntries: [entry], cursor: 9 },
          })
          .then(effect)
      ).rejects.toMatchObject({ reason: 'commit-unknown' })
      expect(effect).not.toHaveBeenCalled()
      const actual = JSON.parse((await store.getExternalState())!)
      await expect(
        store.commitExternalPhase({
          expectedRevision: actual.revision,
          next: JSON.stringify({ ...actual, revision: actual.revision + 1 }),
        })
      ).rejects.toMatchObject({ reason: 'recovery-required' })
      await expect(state.commit({ expectedRevision: actual.revision })).rejects.toMatchObject({
        reason: 'recovery-required',
      })
      // A new facade over the SAME host cannot bypass the adapter's poisoned outcome.
      await expect(
        (await open()).commit({ expectedRevision: actual.revision })
      ).rejects.toMatchObject({ reason: 'recovery-required' })
      vi.restoreAllMocks()
      reopen()
      const recovered = await open()
      expect((await recovered.snapshot()).operations).toEqual(landed ? [operation()] : [])
      expect(await store.get(entry.path)).toEqual(landed ? entry : null)
      expect(await store.getCursor()).toBe(landed ? 9 : 0)
      await expect(recovered.commit({ expectedRevision: landed ? 1 : 0 })).resolves.toMatchObject({
        status: 'committed',
      })
    })
  it('BUG: returns an effect receipt only after COMMIT is independently visible', async () => {
    const state = await open(),
      observer = new SqliteDatabase(file, { readonly: true }),
      exec = SqliteDatabase.prototype.exec
    let acknowledged = false,
      checked = false
    try {
      const read = () =>
        JSON.parse(
          (
            observer
              .prepare("SELECT value FROM meta WHERE key = 'daemon:external-files'")
              .get() as { value: string }
          ).value
        ).revision
      vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(function (this: Database, sql) {
        if (sql === 'COMMIT') {
          expect(read()).toBe(0)
          expect(acknowledged).toBe(false)
        }
        const result = exec.call(this, sql)
        if (sql === 'COMMIT') {
          expect(read()).toBe(1)
          expect(acknowledged).toBe(false)
          checked = true
        }
        return result
      })
      await state.commit({ expectedRevision: 0 }).then(() => {
        acknowledged = true
      })
      expect(checked).toBe(true)
      expect(acknowledged).toBe(true)
    } finally {
      observer.close()
    }
  })
  it('BUG: rechecks stale revisions inside the transaction and preserves one file/wire identity', async () => {
    await open()
    const stale = { ...document(1), operations: [operation()] }
    const peer = SqliteStateStore.open(file)
    try {
      await store.commitExternalPhase({
        expectedRevision: 0,
        next: JSON.stringify(stale),
        ledger: { putEntries: [entry] },
      })
      await expect(
        peer.commitExternalPhase({
          expectedRevision: 0,
          next: JSON.stringify(stale),
          ledger: { cursor: 99 },
        })
      ).rejects.toMatchObject({ reason: 'revision-conflict' })
      await store.commitExternalPhase({
        expectedRevision: 1,
        next: JSON.stringify({ ...stale, revision: 2 }),
        ledger: {
          putEntries: [{ ...entry, path: 'Media/moved.jpg', wirePath: 'Media/moved.jpg' }],
        },
      })
      expect(await store.get(entry.path)).toBeNull()
      expect(await store.byFileId(entry.fileId)).toMatchObject({ path: 'Media/moved.jpg' })
      expect(await store.getCursor()).toBe(0)
    } finally {
      peer.close()
    }
  })
  it('BUG: two real CLI handles racing the same phase cannot both return committed receipts', async () => {
    const first = await open(),
      peer = SqliteStateStore.open(file)
    try {
      const second = await Core.ExternalState.open(peer, 'ledger', binding)
      const outcomes = await Promise.allSettled([
        first.commit({
          expectedRevision: 0,
          operations: [{ expectedRevision: null, next: operation() }],
        }),
        second.commit({
          expectedRevision: 0,
          operations: [{ expectedRevision: null, next: { ...operation(), operationId: 'other' } }],
        }),
      ])
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(
        (outcomes.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason
      ).toMatchObject({ reason: 'revision-conflict' })
      reopen()
      expect((await (await open()).snapshot()).operations).toHaveLength(1)
    } finally {
      peer.close()
    }
  })
  it('BUG: refuses corrupt persistence and malformed/binding-changing raw phase batches', async () => {
    await open()
    await expect(
      store.commitExternalPhase({ expectedRevision: 0, next: '{invalid' })
    ).rejects.toMatchObject({ reason: 'recovery-required' })
    await expect(
      store.commitExternalPhase({
        expectedRevision: 0,
        next: JSON.stringify({
          ...document(1),
          binding: { ...binding, endpoint: 'https://other.example.invalid' },
        }),
      })
    ).rejects.toMatchObject({ reason: 'binding-mismatch' })
    await expect(
      store.commitExternalPhase({
        expectedRevision: 0,
        next: JSON.stringify(document(1)),
        ledger: { metadata: [{ key: 'external-files', value: 'overwrite' }] },
      })
    ).rejects.toMatchObject({ reason: 'aborted' })
    store.setMeta('external-files', '{corrupt')
    reopen()
    await expect(open()).rejects.toMatchObject({ reason: 'recovery-required' })
  })
  it('BUG: enforces file/operation revisions, operation identity and preservation of a pending proven base', async () => {
    const state = await open()
    await state.commit({
      expectedRevision: 0,
      files: [{ expectedRevision: null, next: record() }],
      operations: [{ expectedRevision: null, next: operation() }],
    })
    await expect(
      state.commit({
        expectedRevision: 1,
        files: [{ expectedRevision: 9, next: { ...record(), localRevision: 10 } }],
      })
    ).rejects.toMatchObject({ reason: 'revision-conflict' })
    await expect(
      state.commit({
        expectedRevision: 1,
        operations: [
          {
            expectedRevision: 0,
            next: { ...operation(), revision: 1, expected: { ...expected, versionId: 'other' } },
          },
        ],
      })
    ).rejects.toMatchObject({ reason: 'operation-mismatch' })
    await expect(
      state.commit({
        expectedRevision: 1,
        files: [
          {
            expectedRevision: 0,
            next: { ...record(), localRevision: 1, lastProvenLocalBase: null },
          },
        ],
      })
    ).rejects.toMatchObject({ reason: 'recovery-required' })
    reopen()
    expect((await (await open()).snapshot()).files[0]!.lastProvenLocalBase).toEqual(base)
  })
  it('BUG: does not rebind the same vault to a different endpoint, principal or credential slot', async () => {
    await open()
    expect(
      (
        await Core.ExternalState.open(store, 'ledger', {
          ...binding,
          endpoint: 'HTTPS://SYNC.EXAMPLE.INVALID:443/',
        })
      ).binding.endpoint
    ).toBe(binding.endpoint)
    for (const patch of [
      { endpoint: 'https://other.example.invalid' },
      { principalId: 'other' },
      { generation: 2 },
      { credentialAssociation: 'other-slot' },
    ])
      await expect(
        Core.ExternalState.open(store, 'ledger', { ...binding, ...patch })
      ).rejects.toMatchObject({ reason: 'binding-mismatch' })
  })
  it('BUG: refuses production memory fallback, including an actual in-memory CLI SQLite store', async () => {
    await expect(
      Core.ExternalState.open(
        new Core.MemoryStateStore() as unknown as Core.ExternalStatePort,
        'ledger',
        binding
      )
    ).rejects.toMatchObject({ reason: 'unsupported-storage' })
    const memory = SqliteStateStore.open(':memory:')
    try {
      await expect(Core.ExternalState.open(memory, 'ledger', binding)).rejects.toMatchObject({
        reason: 'unsupported-storage',
      })
    } finally {
      memory.close()
    }
  })
  it('BUG: updates the existing scoped checkpoint in the same ledger rather than introducing another head table', async () => {
    const scopedBinding = {
      version: 4 as const,
      facet: 'scoped' as const,
      endpoint_identity: binding.endpoint,
      vault_id: binding.vaultId,
      grant_id: 'grant',
      principal_kind: 'key' as const,
      principal_id: 'key',
      credential_fingerprint: 'e'.repeat(64),
    }
    await Core.ScopedState.open(store, scopedBinding, { initialize: true })
    const externalBinding = {
      ...binding,
      mode: 'scoped' as const,
      grantId: 'grant',
      principalId: 'key',
      principalType: 'key' as const,
    }
    const state = await Core.ExternalState.open(store, 'ledger', externalBinding)
    const root = JSON.parse(store.getMeta('scoped-v4-state')!)
    const checkpoint = { kind: 'scoped' as const, token: 'checkpoint' }
    await state.commit({
      expectedRevision: 0,
      operations: [{ expectedRevision: null, next: operation() }],
      ledger: {
        metadata: [{ key: 'scoped-v4-state', value: JSON.stringify({ ...root, checkpoint }) }],
      },
    })
    reopen()
    const scoped = await Core.ScopedState.open(store, scopedBinding)
    expect(await scoped.getCheckpoint()).toEqual(checkpoint)
    expect(
      (await (await Core.ExternalState.open(store, 'ledger', externalBinding)).snapshot())
        .operations[0]!.phase
    ).toBe('prepared')
  })
})
