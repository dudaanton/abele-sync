import { expect, it, vi } from 'vitest'
import { AbeleError } from '@abele/sync-protocol'
import { serverHarness } from '../helpers/harness.js'
import {
  MemoryFileSystem,
  MemoryStateStore,
  ExpectedWrites,
  encodeText,
  scan,
  push,
  resumeJournal,
  type Refusal,
  type Journal,
} from '../../src/index.js'
it('runs durable owner pre-upload and exact settlement hooks with novel versus adopted creation receipts', async () => {
  const t = await serverHarness()
  try {
    const owner = await t.account(),
      vault = (await t.vault(owner.accountToken)).vaultId,
      device = await t.device(owner.accountToken, vault),
      client = t.clientFor(device.deviceToken, vault)
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore(),
      events: any[] = []
    await fs.writeAtomic('New.md', encodeText('new'), 1)
    const beforeUpload = vi.fn(async (unit: any) => {
      expect(await state.getJournal()).not.toBeNull()
      events.push(['before', unit.operations[0].handle])
    })
    const onSettled = vi.fn(async (item: any, bytes: Uint8Array | null) => {
      events.push(['settled', item.creation, new TextDecoder().decode(bytes!)])
      expect(await state.getJournal()).not.toBeNull()
    })
    const opts = { expected: new ExpectedWrites(), beforeUpload, onSettled }
    const found = await scan(fs, state, { excluded: () => false })
    await push(client, fs, state, found, opts)
    expect(events.map((event) => event[0])).toEqual(['before', 'settled'])
    expect(events[1]).toEqual(['settled', 'novel', 'new'])
    const otherState = new MemoryStateStore()
    const adopted = await push(
      client,
      fs,
      otherState,
      await scan(fs, otherState, { excluded: () => false }),
      {
        ...opts,
        beforeUpload: async () => {},
        onSettled: async (item: any) => {
          expect(item.creation).toBe('adopted')
        },
      }
    )
    expect(adopted.committed?.creation_outcomes).toEqual([{ index: 0, kind: 'adopted' }])
    expect(adopted.committed?.results[0]).toMatchObject({ status: 'applied' })
  } finally {
    await t.close()
  }
})
it('replays a submitted unit and retries failed settlement hooks without re-running mutable preflight', async () => {
  const t = await serverHarness()
  try {
    const owner = await t.account(),
      vault = (await t.vault(owner.accountToken)).vaultId,
      device = await t.device(owner.accountToken, vault),
      client = t.clientFor(device.deviceToken, vault)
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    await fs.writeAtomic('New.md', encodeText('new'), 1)
    const beforeUpload = vi.fn(async () => {}),
      onSettled = vi.fn(async () => {})
    onSettled.mockRejectedValueOnce(new Error('hook crash'))
    const opts = { expected: new ExpectedWrites(), beforeUpload, onSettled }
    await expect(
      push(client, fs, state, await scan(fs, state, { excluded: () => false }), opts)
    ).rejects.toThrow('hook crash')
    const request = (await state.getJournal())!.idempotencyKey
    expect((await state.getJournal())?.publicationPhase).toBe('submitted')
    await resumeJournal(client, fs, state, opts)
    expect(beforeUpload).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(2)
    expect(await state.getJournal()).toBeNull()
    expect(
      await t.db.selectFrom('idempotency').select('key').where('key', '=', request).execute()
    ).toHaveLength(1)
    expect(await t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
  } finally {
    await t.close()
  }
})
it('recovers the exact submitted body even when a rejected sibling survives in the external refusal map', async () => {
  const t = await serverHarness()
  try {
    const owner = await t.account(),
      vault = (await t.vault(owner.accountToken)).vaultId,
      device = await t.device(owner.accountToken, vault),
      client = t.clientFor(device.deviceToken, vault)
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore(),
      refused = new Map<string, Refusal>()
    await fs.writeAtomic('A.md', encodeText('ok'), 1)
    await fs.writeAtomic('B.md', encodeText('too long'), 1)
    const original = client.commitRaw.bind(client),
      sent: any[] = []
    const transport = vi.spyOn(client, 'commitRaw').mockImplementation(async (ops, key) => {
      sent.push({ ops: structuredClone(ops), key })
      const row = await t.db
        .selectFrom('vaults')
        .select('settings')
        .where('id', '=', vault)
        .executeTakeFirstOrThrow()
      await t.db
        .updateTable('vaults')
        .set({ settings: JSON.stringify({ ...JSON.parse(row.settings), max_file_bytes: 3 }) })
        .where('id', '=', vault)
        .execute()
      return original(ops, key)
    })
    const onSettled = vi.fn(async () => {})
    onSettled.mockRejectedValueOnce(new Error('settlement crash'))
    const opts = { expected: new ExpectedWrites(), refused, onSettled }
    await expect(
      push(client, fs, state, await scan(fs, state, { excluded: () => false }), opts)
    ).rejects.toThrow('settlement crash')
    expect(refused.size).toBe(1)
    expect((await state.getJournal())?.ops).toHaveLength(2)
    const saved = await state.getJournal()
    transport.mockRejectedValueOnce(
      new AbeleError('idempotency_mismatch', 'simulated ambiguous replay')
    )
    await expect(resumeJournal(client, fs, state, opts)).rejects.toMatchObject({
      code: 'idempotency_mismatch',
    })
    expect(await state.getJournal()).toEqual(saved)
    expect(onSettled).toHaveBeenCalledTimes(1)
    await resumeJournal(client, fs, state, opts)
    expect(sent[1]).toEqual(sent[0])
    expect(onSettled).toHaveBeenCalledTimes(2)
    expect(await state.getJournal()).toBeNull()
    expect(await t.db.selectFrom('versions').select('id').execute()).toHaveLength(1)
  } finally {
    await t.close()
  }
})
it('atomically replaces a partially released hold with one remainder and the sending journal across a crash', async () => {
  const t = await serverHarness()
  try {
    const owner = await t.account(),
      vault = (await t.vault(owner.accountToken)).vaultId,
      device = await t.device(owner.accountToken, vault),
      client = t.clientFor(device.deviceToken, vault)
    class CrashStore extends MemoryStateStore {
      armed = false
      override async transaction<T>(fn: () => Promise<T>): Promise<T> {
        const result = await super.transaction(fn)
        if (this.armed) {
          this.armed = false
          throw new Error('crash after split commit')
        }
        return result
      }
    }
    const fs = new MemoryFileSystem(),
      state = new CrashStore()
    await fs.writeAtomic('A.md', encodeText('base A'), 1)
    await fs.writeAtomic('B.md', encodeText('base B'), 1)
    await push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
      expected: new ExpectedWrites(),
    })
    await fs.writeAtomic('A.md', encodeText('edited A'), 2)
    await fs.writeAtomic('B.md', encodeText('edited B'), 2)
    let phase: 'hold' | 'partial' | 'all' = 'hold'
    const onSettled = vi.fn(async (_item: any) => {}),
      beforeUpload = vi.fn(async (unit: any) => ({
        holdIndices:
          phase === 'hold'
            ? unit.ops.map((_op: any, index: number) => index)
            : phase === 'partial'
              ? unit.ops.flatMap((op: any, index: number) =>
                  op.file_id === unit.ops[1]?.file_id ? [index] : []
                )
              : [],
      }))
    const opts = { expected: new ExpectedWrites(), beforeUpload, onSettled }
    await push(client, fs, state, await scan(fs, state, { excluded: () => false }), opts)
    const held = JSON.parse((await state.getMeta('owner-publication-held'))!) as Journal[],
      original = held[0]!
    expect(held).toHaveLength(1)
    phase = 'partial'
    state.armed = true
    await expect(resumeJournal(client, fs, state, opts)).rejects.toThrow('crash after split commit')
    const remainder = JSON.parse((await state.getMeta('owner-publication-held'))!) as Journal[]
    expect(remainder).toHaveLength(1)
    expect(remainder[0]!.ops).toHaveLength(1)
    const active = await state.getJournal()
    expect(active?.ops).toHaveLength(1)
    expect(active?.idempotencyKey).toBe(original.idempotencyKey)
    expect(active?.ops[0]).not.toEqual(remainder[0]!.ops[0])
    phase = 'all'
    await resumeJournal(client, fs, state, opts)
    expect(onSettled).toHaveBeenCalledTimes(2)
    const handles = onSettled.mock.calls.map((call) => (call[0] as any).handle)
    expect(new Set(handles).size).toBe(2)
    expect(await state.getJournal()).toBeNull()
    expect(JSON.parse((await state.getMeta('owner-publication-held'))!)).toEqual([])
    expect(await t.db.selectFrom('versions').select('id').execute()).toHaveLength(4)
  } finally {
    await t.close()
  }
})
it('holds publication-sensitive creates durably while unrelated personal content commits, then retries the same held handles', async () => {
  const t = await serverHarness()
  try {
    const owner = await t.account(),
      vault = (await t.vault(owner.accountToken)).vaultId,
      device = await t.device(owner.accountToken, vault),
      client = t.clientFor(device.deviceToken, vault)
    const fs = new MemoryFileSystem(),
      state = new MemoryStateStore()
    let ready = false
    await fs.writeAtomic('Paste.png', encodeText('image'), 1)
    await fs.writeAtomic('Other.md', encodeText('other'), 1)
    const beforeUpload = vi.fn(async (unit: any) => ({
      holdIndices: ready
        ? []
        : unit.operations
            .filter((entry: any) => entry.op.op === 'create' && entry.op.path === 'Paste.png')
            .map((entry: any) => entry.index),
    }))
    await push(client, fs, state, await scan(fs, state, { excluded: () => false }), {
      expected: new ExpectedWrites(),
      beforeUpload,
    })
    expect(await state.get('Other.md')).not.toBeNull()
    expect(await state.get('Paste.png')).toBeNull()
    ready = true
    await resumeJournal(client, fs, state, { expected: new ExpectedWrites(), beforeUpload })
    expect(await state.get('Paste.png')).not.toBeNull()
    const handles = beforeUpload.mock.calls.flatMap((call) =>
      call[0].operations
        .filter((entry: any) => entry.op.path === 'Paste.png')
        .map((entry: any) => entry.handle)
    )
    expect(new Set(handles).size).toBe(1)
  } finally {
    await t.close()
  }
})
