import { describe, expect, it, vi } from 'vitest'
import { createScopedClient, ScopedState } from '../../src/scopedConnection.js'
import { MemoryStateStore } from '../../src/state.js'
const KEY_TOKEN = `absk_${'a'.repeat(43)}`
const options = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => ({
  baseUrl: 'https://issuer.example.test',
  token: KEY_TOKEN,
  vaultId: 'vault',
  grantId: 'grant',
  principalId: 'key',
  principalKind: 'key' as const,
  fetch,
  ...extra,
})
describe('scoped client and durable connection state', () => {
  it('binds issuer/vault/principal/grant/credential and never stores the credential or a numeric remote cursor', async () => {
    const client = await createScopedClient(options(vi.fn() as unknown as typeof fetch)),
      raw = new MemoryStateStore()
    const state = await ScopedState.open(raw, client.binding, { initialize: true })
    await state.setCheckpoint({ kind: 'scoped', token: 'opaque' })
    expect(await state.getCheckpoint()).toEqual({ kind: 'scoped', token: 'opaque' })
    expect(await raw.getCursor()).toBe(0)
    await expect(state.setCheckpoint(19)).rejects.toMatchObject({ code: 'protocol' })
    expect(await raw.getMeta('scoped-v4-state')).not.toContain(KEY_TOKEN)
    for (const extra of [
      { baseUrl: 'https://other.example.test' },
      { vaultId: 'other' },
      { grantId: 'other' },
      { principalId: 'other' },
      { token: `absk_${'b'.repeat(43)}` },
    ]) {
      const other = await createScopedClient(options(vi.fn() as unknown as typeof fetch, extra))
      await expect(ScopedState.open(raw, other.binding)).rejects.toMatchObject({ code: 'lost' })
    }
    expect(await state.getCheckpoint()).toEqual({ kind: 'scoped', token: 'opaque' })
  })
  it('requires explicit missing-ledger recovery and refuses personal state or an optional metadata fallback', async () => {
    const client = await createScopedClient(options(vi.fn() as unknown as typeof fetch)),
      raw = new MemoryStateStore()
    await expect(ScopedState.open(raw, client.binding)).rejects.toMatchObject({ code: 'lost' })
    await raw.setCursor(7)
    await expect(ScopedState.open(raw, client.binding, { initialize: true })).rejects.toMatchObject(
      { code: 'lost' }
    )
    await raw.setCursor(0)
    const optional = {
      ...raw,
      getMeta: undefined,
      setMeta: undefined,
    } as unknown as MemoryStateStore
    await expect(
      ScopedState.open(optional, client.binding, { initialize: true })
    ).rejects.toMatchObject({ code: 'lost' })
  })
  it('recovers only its bound tagged journal and keeps known-not-materialized separate from deletion', async () => {
    const client = await createScopedClient(options(vi.fn() as unknown as typeof fetch)),
      raw = new MemoryStateStore()
    const state = await ScopedState.open(raw, client.binding, { initialize: true })
    const journal = {
      kind: 'scoped',
      binding: client.binding,
      request_id: 'durable',
      ops: [{ op: 'create', path: 'Agents/new.md', sha: 'a'.repeat(64), size: 3, mtime: 1 }],
      startedAt: '2030-01-01T00:00:00.000Z',
    }
    await state.setJournal(journal)
    await state.putKnown({
      file_id: 'file',
      version_id: 'version',
      path: 'Agents/new.md',
      sha: 'a'.repeat(64),
      size: 3,
      mtime: 1,
      state: 'known_not_materialized',
      dirty: false,
    })
    const reopened = await ScopedState.open(raw, client.binding)
    expect(await reopened.getJournal()).toEqual(journal)
    expect((await reopened.getKnown('file'))!.state).toBe('known_not_materialized')
    expect(await raw.getJournal()).toBeNull()
    await expect(
      reopened.setJournal({ ...journal, binding: { ...client.binding, grant_id: 'other' } })
    ).rejects.toMatchObject({ code: 'lost' })
  })
  it('rolls known-file metadata back atomically and refuses personal state introduced after opening', async () => {
    const client = await createScopedClient(options(vi.fn() as unknown as typeof fetch)),
      raw = new MemoryStateStore()
    const state = await ScopedState.open(raw, client.binding, { initialize: true })
    vi.spyOn(raw, 'setMeta').mockRejectedValueOnce(new Error('disk fault'))
    await expect(
      state.putKnown({
        file_id: 'file',
        version_id: 'version',
        path: 'Agents/new.md',
        sha: 'a'.repeat(64),
        size: 3,
        mtime: 1,
        state: 'held',
        dirty: true,
      })
    ).rejects.toThrow('disk fault')
    expect(await state.getKnown('file')).toBeNull()
    expect(await raw.getMeta('scoped-v4-file:file')).toBeNull()
    await raw.setCursor(1)
    await expect(state.getCheckpoint()).rejects.toMatchObject({ code: 'lost' })
  })
  it('sends strict scoped version/no-store requests and refuses disabled capability negotiation without personal fallback', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ protocol_version: 1, device: true, scoped: { enabled: false } }),
          { status: 200 }
        )
    )
    const client = await createScopedClient(options(fetchMock as unknown as typeof fetch))
    await expect(client.negotiate()).rejects.toMatchObject({ code: 'scoped_unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://issuer.example.test/v1/capabilities')
    expect(init.headers).toMatchObject({
      'x-abele-scoped-version': '4',
      authorization: `Bearer ${KEY_TOKEN}`,
    })
    expect(init.redirect).toBe('manual')
    expect(init.cache).toBe('no-store')
    for (const token of ['absd_device', 'abst_account', 'absi_installation'])
      await expect(
        createScopedClient(options(fetchMock as unknown as typeof fetch, { token }))
      ).rejects.toMatchObject({ code: 'unauthorized' })
  })
  it('verifies the server principal/vault/grant/issuer tuple after capabilities rather than trusting setup labels', async () => {
    const { SCOPED_LIMITS, SCOPED_REQUIRED_CAPABILITIES } = await import('@abele/sync-protocol')
    const capabilities = {
      protocol_version: 1,
      device: true,
      scoped: {
        enabled: true,
        protocol_version: 4,
        modes: { folder: true, group: false },
        features: Object.fromEntries(SCOPED_REQUIRED_CAPABILITIES.map((name) => [name, true])),
        limits: SCOPED_LIMITS,
      },
    }
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).endsWith('/capabilities')
              ? capabilities
              : {
                  endpoint_identity: 'https://issuer.example.test',
                  vault_id: 'vault',
                  grant_id: 'other',
                  principal_kind: 'key',
                  principal_id: 'key',
                  role: 'editor',
                  state: 'active',
                  selector: { kind: 'folder', prefix: 'Agents/' },
                }
          ),
          { status: 200 }
        )
    )
    const client = await createScopedClient(options(fetchMock as unknown as typeof fetch))
    await expect(client.negotiate()).rejects.toMatchObject({ code: 'protocol' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('uses only the scoped commit path and refuses redirect delivery', async () => {
    const response = { outcome_id: 'outcome', acknowledged: true, results: [] },
      fetchMock = vi.fn(
        async (_url: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify(response), { status: 200 })
      )
    const client = await createScopedClient(options(fetchMock as unknown as typeof fetch))
    const request = {
      request_id: 'durable',
      ops: [{ op: 'delete' as const, file_id: 'file', base_version_id: 'version' }],
    }
    expect(await client.commit(request)).toEqual(response)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://issuer.example.test/v1/scoped/vaults/vault/grants/grant/commit'
    )
    const redirected = await createScopedClient(
      options(
        vi.fn(
          async () =>
            new Response(null, { status: 302, headers: { location: 'https://other.example.test' } })
        ) as unknown as typeof fetch
      )
    )
    await expect(redirected.commit(request)).rejects.toMatchObject({ code: 'protocol' })
  })
})
