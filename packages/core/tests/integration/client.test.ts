import {
  AbeleError,
  type CommitOp,
  type CommitOpResult,
  type CommitResponse,
} from '@abele/sync-protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EngineError, SyncClient, encodeText, sha256, type VaultClient } from '../../src/index.js'
import { BASE_URL, serverHarness, TEST_PASSWORD, type Harness } from '../helpers/harness.js'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `check` holds; a test that waits forever is a failed test, not a hung one. */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await wait(10)
  }
}

/** Bytes and the name they will be filed under, uploaded and ready for an op to name. */
async function blob(client: VaultClient, text: string): Promise<{ sha: string; size: number }> {
  const bytes = encodeText(text)
  const sha = await sha256(bytes)
  await client.putBlob(sha, bytes)
  return { sha, size: bytes.length }
}

/** A create op for text this uploads first. */
async function create(
  client: VaultClient,
  path: string,
  text: string,
  mtime = 1
): Promise<CommitOp> {
  return { op: 'create', path, ...(await blob(client, text)), mtime }
}

/** One result, insisting the server applied it, so a test can name the version it made. */
function applied(
  result: CommitOpResult | undefined
): Extract<CommitOpResult, { status: 'applied' }> {
  if (result?.status !== 'applied') throw new Error(`not applied: ${JSON.stringify(result)}`)
  return result
}

/** The single result of a single-op commit. */
const only = (response: CommitResponse): Extract<CommitOpResult, { status: 'applied' }> =>
  applied(response.results[0])

describe('SyncClient over the device facet', () => {
  let h: Harness
  let accountToken: string

  /** A vault of its own, with a device enrolled on it, so no test disturbs another. */
  async function ownVault(
    name: string
  ): Promise<{ vaultId: string; deviceToken: string; client: VaultClient }> {
    const { vaultId } = await h.vault(accountToken, name)
    const { deviceToken } = await h.device(accountToken, vaultId, `${name} device`)
    return { vaultId, deviceToken, client: h.clientFor(deviceToken, vaultId) }
  }

  beforeAll(async () => {
    h = await serverHarness()
    accountToken = (await h.account('owner@abele.test')).accountToken
  })

  afterAll(async () => {
    await h.close()
  })

  it('logs in, makes a vault, enrols a device, and reads what that vault is doing', async () => {
    const session = await SyncClient.login(BASE_URL, h.fetch, 'owner@abele.test', TEST_PASSWORD)
    expect(session.account_token).toMatch(/^abst_/)
    expect(Date.parse(session.expires_at)).toBeGreaterThan(Date.now())

    const account = h.clientOn(session.account_token)
    const { id } = await account.createVault('Enrolled')
    expect(await account.listVaults()).toContainEqual(
      expect.objectContaining({ id, name: 'Enrolled' })
    )

    const enrolled = await account.enrolDevice(id, 'laptop', 'desktop')
    expect(enrolled.device_token).toMatch(/^absd_/)
    expect((await account.listDevices()).map((device) => device.id)).toContain(enrolled.device_id)

    const state = await h.clientFor(enrolled.device_token, id).state()
    expect(state.head_seq).toBe(0)
    expect(state.settings.conflict).toBe('merge')
    expect(state.usage.live_bytes).toBe(0)

    await account.revokeDevice(enrolled.device_id)
    expect((await account.listDevices()).map((device) => device.id)).not.toContain(
      enrolled.device_id
    )
  })

  /**
   * The vault's settings, which every device on it shares — as against the selective settings,
   * which are one device's own and never leave it.
   */
  it('patches the vault settings and leaves the fields it did not name alone', async () => {
    const { client } = await ownVault('Policy')
    const before = (await client.state()).settings

    const patched = await client.updateSettings(
      {
        conflict: 'conflict-file',
        key_signature: { enabled: true, property: 'encrypted', value: 'yes' },
        retention: { notes_days: 30 },
      },
      TEST_PASSWORD
    )

    expect(patched.conflict).toBe('conflict-file')
    expect(patched.key_signature).toEqual({ enabled: true, property: 'encrypted', value: 'yes' })
    // Retention merges span by span: naming one must not reset the others to their defaults.
    expect(patched.retention.notes_days).toBe(30)
    expect(patched.retention.attachments_days).toBe(before.retention.attachments_days)
    // And nothing the patch was silent about moved.
    expect(patched.scripts_folder).toBe(before.scripts_folder)
    expect(patched.max_file_bytes).toBe(before.max_file_bytes)

    // What came back is what the server now holds, not just what this call said.
    expect((await client.state()).settings).toEqual(patched)
  })

  it('passes a one-request password proof for protected settings, without elevating later calls', async () => {
    const { client } = await ownVault('Protected policy')
    await expect(client.updateSettings({ retention: { notes_days: 0 } })).rejects.toMatchObject({
      code: 'account_password_required',
    })
    expect(
      (await client.updateSettings({ retention: { notes_days: 0 } }, TEST_PASSWORD)).retention
        .notes_days
    ).toBe(0)
    await expect(client.updateSettings({ quota_bytes: 10 })).rejects.toMatchObject({
      code: 'account_password_required',
    })
    await client.updateSettings({ quota_bytes: 10 }, TEST_PASSWORD)
    await expect(client.updateSettings({ quota_bytes: null })).rejects.toMatchObject({
      code: 'account_password_required',
    })
    expect(
      (await client.updateSettings({ quota_bytes: null }, TEST_PASSWORD)).quota_bytes
    ).toBeNull()
  })

  it('walks the manifest a page at a time and reads the changes behind it', async () => {
    const { client } = await ownVault('Manifest')
    const paths = ['notes/a.md', 'notes/b.md', 'notes/c.md', 'notes/d.md', 'notes/e.md']
    const ops: CommitOp[] = []
    for (const path of paths) ops.push(await create(client, path, `# ${path}`))
    const committed = await client.commit(ops, 'manifest-seed')

    const pages = []
    let cursor: string | null = null
    do {
      const page = await client.manifest(cursor, 2)
      pages.push(page)
      cursor = page.next
    } while (cursor !== null)

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1])
    expect(pages.flatMap((page) => page.items.map((item) => item.path))).toEqual(paths)
    expect(pages.every((page) => page.head_seq === committed.head_seq)).toBe(true)

    const changes = await client.changes(0, 3)
    expect(changes.items.map((item) => item.op)).toEqual(['create', 'create', 'create'])
    expect(changes.head_seq).toBe(committed.head_seq)
    const rest = await client.changes(changes.next_since)
    expect(rest.items.length).toBe(2)
    expect(rest.next_since).toBe(committed.head_seq)
  })

  it('commits a batch, and hands back the first answer when the key comes again', async () => {
    const { client } = await ownVault('Commit')
    const op = await create(client, 'notes/one.md', 'hello')

    const first = await client.commitRaw([op], 'commit-1')
    expect(first.replayed).toBe(false)
    expect(only(first.body)).toMatchObject({ path: 'notes/one.md', seq: first.body.head_seq })

    const again = await client.commitRaw([op], 'commit-1')
    expect(again.replayed).toBe(true)
    expect(again.body).toEqual(first.body)
    // The replay was an answer repeated, not a batch applied twice.
    expect((await client.state()).head_seq).toBe(first.body.head_seq)

    const second = await client.commit([await create(client, 'notes/two.md', 'more')], 'commit-2')
    expect(second.head_seq).toBeGreaterThan(first.body.head_seq)
  })

  it('uploads a blob in parts once it is over the simple limit', async () => {
    // The server cuts uploads into 1 KiB parts here, so five parts is five requests.
    const parts = await serverHarness({ partBytes: 1024 })
    try {
      const owner = (await parts.account('parts@abele.test')).accountToken
      const { vaultId } = await parts.vault(owner, 'Parts')
      const { deviceToken } = await parts.device(owner, vaultId, 'uploader')

      const asked: string[] = []
      const counted: typeof fetch = (input, init) => {
        asked.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`)
        return parts.fetch(input, init)
      }
      const client = parts.clientFor(deviceToken, vaultId, {
        fetch: counted,
        simpleUploadBytes: 1024,
      })

      const bytes = new Uint8Array(5 * 1024)
      for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7) % 256
      const sha = await sha256(bytes)
      await client.putBlob(sha, bytes)

      expect(asked.filter((call) => call.endsWith('/upload'))).toHaveLength(1)
      expect(asked.filter((call) => /\/upload\/[^/]+\/\d+$/.test(call))).toHaveLength(5)
      expect(asked.filter((call) => call.endsWith('/complete'))).toHaveLength(1)
      // Never the simple route, and never a request the resumable one did not need.
      expect(asked).not.toContain(`PUT /v1/blobs/${sha}`)

      // The bytes are stored, but no version of this vault names them yet.
      expect(await client.hasBlob(sha)).toBe(false)
      const op: CommitOp = {
        op: 'create',
        path: 'files/big.bin',
        sha,
        size: bytes.length,
        mtime: 2,
      }
      expect(only(await client.commit([op], 'big-1'))).toMatchObject({ path: 'files/big.bin' })
      expect(await client.hasBlob(sha)).toBe(true)
      expect(await client.getBlob(sha)).toEqual(bytes)

      // How a file divides is arithmetic: a server that counts it differently is
      // not one this client can send bytes to, whatever else it agrees about.
      const miscounting: typeof fetch = async (input, init) => {
        const answer = await parts.fetch(input, init)
        if (!String(input).endsWith('/upload')) return answer
        const body = (await answer.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ ...body, parts: 99 }), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      const confused = parts.clientFor(deviceToken, vaultId, {
        fetch: miscounting,
        simpleUploadBytes: 1024,
      })
      const miscount = await confused.putBlob(sha, bytes).catch((thrown: unknown) => thrown)
      expect(miscount).toBeInstanceOf(EngineError)
      expect((miscount as EngineError).code).toBe('protocol')
    } finally {
      await parts.close()
    }
  })

  it('a new client sends only parts missing from the interrupted upload', async () => {
    const parts = await serverHarness({ partBytes: 1024 })
    try {
      const owner = (await parts.account('resume-parts@abele.test')).accountToken
      const { vaultId } = await parts.vault(owner, 'Resume parts')
      const { deviceToken } = await parts.device(owner, vaultId, 'uploader')
      const bytes = new Uint8Array(3 * 1024).fill(4)
      const sha = await sha256(bytes)
      let sent = 0
      const interrupted: typeof fetch = (input, init) => {
        if (init?.method === 'PUT' && /\/upload\/[^/]+\/\d+$/.test(String(input))) {
          if (++sent === 2) throw new Error('connection dropped')
        }
        return parts.fetch(input, init)
      }
      await expect(
        parts
          .clientFor(deviceToken, vaultId, {
            fetch: interrupted,
            simpleUploadBytes: 1024,
          })
          .putBlob(sha, bytes)
      ).rejects.toThrow('never reached the server')
      const resent: string[] = []
      const resumed: typeof fetch = (input, init) => {
        if (init?.method === 'PUT') resent.push(String(input))
        return parts.fetch(input, init)
      }
      await parts
        .clientFor(deviceToken, vaultId, {
          fetch: resumed,
          simpleUploadBytes: 1024,
        })
        .putBlob(sha, bytes)
      expect(resent.map((url) => Number(url.split('/').at(-1)))).toEqual([1, 2])
    } finally {
      await parts.close()
    }
  })

  it('reads history, restores a version, and empties the trash back into the vault', async () => {
    const { client } = await ownVault('History')
    const created = only(await client.commit([await create(client, 'notes/h.md', 'one')], 'h-1'))
    const modified = only(
      await client.commit(
        [
          {
            op: 'modify',
            file_id: created.file_id,
            base_version_id: created.version_id,
            ...(await blob(client, 'two')),
            mtime: 3,
          },
        ],
        'h-2'
      )
    )

    const history = await client.versions(created.file_id)
    expect(history.map((version) => version.version_id).sort()).toEqual(
      [created.version_id, modified.version_id].sort()
    )
    expect(await client.versions(created.file_id, { limit: 1 })).toHaveLength(1)
    expect(await client.versionBytes(created.file_id, created.version_id)).toEqual(
      encodeText('one')
    )

    const restored = applied(await client.restore(created.file_id, created.version_id, 'h-restore'))
    // The same restore under the same key is the same answer, not a second version.
    expect(await client.restore(created.file_id, created.version_id, 'h-restore')).toEqual(restored)
    expect(await client.versions(created.file_id)).toHaveLength(3)

    const deleted = only(
      await client.commit(
        [{ op: 'delete', file_id: created.file_id, base_version_id: restored.version_id }],
        'h-3'
      )
    )
    expect(deleted.file_id).toBe(created.file_id)
    expect((await client.trash()).map((item) => item.file_id)).toEqual([created.file_id])

    const undeleted = applied(await client.restoreDeleted(created.file_id, 'h-undelete'))
    expect(undeleted.path).toBe('notes/h.md')
    // Retrying it would otherwise be an undelete of a file that is not deleted.
    expect(await client.restoreDeleted(created.file_id, 'h-undelete')).toEqual(undeleted)
    expect(await client.trash()).toEqual([])

    const usage = await client.usage()
    expect(usage.live_bytes).toBeGreaterThan(0)
    expect(Array.isArray(usage.top)).toBe(true)
    const activity = await client.activity(0, 10)
    expect(activity.map((item) => item.op)).toContain('restore')
  })

  it('restores many deleted files, in batches of at most a thousand, one result per id', async () => {
    const { client } = await ownVault('Bulk restore')
    const ids: string[] = []
    for (const name of ['a', 'b']) {
      const bytes = encodeText(name)
      const sha = await sha256(bytes)
      await client.putBlob(sha, bytes)
      const made = only(
        await client.commit(
          [{ op: 'create', path: `${name}.md`, sha, size: 1, mtime: 1 }],
          `bulk-c-${name}`
        )
      )
      only(
        await client.commit(
          [{ op: 'delete', file_id: made.file_id, base_version_id: made.version_id }],
          `bulk-d-${name}`
        )
      )
      ids.push(made.file_id)
    }
    const trash = await client.trash()
    expect(trash.map((item) => item.deleted_by?.kind)).toEqual(['device', 'device'])

    // 999 ids nobody has, then the two real ones: the second one lands in a batch of its own.
    const unknown = Array.from({ length: 999 }, (_, k) => `nobody-${k}`)
    const results = await client.restoreDeletedMany([...unknown, ...ids], 'bulk-key')
    expect(results).toHaveLength(1001)
    expect(
      results.slice(0, 999).every((r) => r.status === 'rejected' && r.code === 'not_found')
    ).toBe(true)
    expect(results.slice(999).map((r) => r.status)).toEqual(['applied', 'applied'])
    expect(await client.trash()).toEqual([])
    // The same call under the same key is answered by what landed; nothing is restored twice.
    expect(await client.restoreDeletedMany([...unknown, ...ids], 'bulk-key')).toEqual(results)
  })

  it('throws the error the server sent, with its code, when the token is no good', async () => {
    const { vaultId } = await ownVault('Refused')
    const error = await h
      .clientFor('absd_nothing', vaultId)
      .state()
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(AbeleError)
    expect((error as AbeleError).code).toBe('unauthorized')
    expect((error as AbeleError).status).toBe(401)
    expect((error as AbeleError).message).not.toBe('')
  })

  it('refuses a bodiless head the way it refuses everything else', async () => {
    const { vaultId } = await h.vault(accountToken, 'Revoked')
    const { deviceId, deviceToken } = await h.device(accountToken, vaultId, 'revoked device')
    const client = h.clientFor(deviceToken, vaultId)
    await h.clientOn(accountToken).revokeDevice(deviceId)

    // A HEAD carries no body, so the envelope the server wrote never reaches the
    // client: the status is all it has, and it must read the same as any other call.
    const head = await client.hasBlob('a'.repeat(64)).catch((thrown: unknown) => thrown)
    const get = await client.state().catch((thrown: unknown) => thrown)

    expect(head).toBeInstanceOf(AbeleError)
    expect((head as AbeleError).code).toBe('unauthorized')
    expect((head as AbeleError).status).toBe(401)
    expect((get as AbeleError).code).toBe('unauthorized')
  })

  it('tells a refusal it cannot read apart from an answer it cannot read', async () => {
    const { vaultId, deviceToken } = await ownVault('Strangers')
    /** Something between the client and the server, answering for itself. */
    const answering =
      (status: number, body: string, type = 'text/html'): typeof fetch =>
      () =>
        Promise.resolve(new Response(body, { status, headers: { 'content-type': type } }))
    const state = (answer: typeof fetch): Promise<unknown> =>
      h
        .clientFor(deviceToken, vaultId, { fetch: answer })
        .state()
        .catch((thrown: unknown) => thrown)

    // A door that refuses the token before the server ever sees it.
    const refused = await state(answering(401, '<html>sign in</html>'))
    expect(refused).toBeInstanceOf(EngineError)
    expect((refused as EngineError).code).toBe('unauthorized')

    // A proxy with an opinion of its own.
    const gateway = await state(answering(502, 'bad gateway'))
    expect(gateway).toBeInstanceOf(EngineError)
    expect((gateway as EngineError).code).toBe('protocol')

    // A server that answered, in words this client does not know.
    const drift = await state(answering(200, '{"head_seq":"soon"}', 'application/json'))
    expect(drift).toBeInstanceOf(EngineError)
    expect((drift as EngineError).code).toBe('protocol')
  })

  it('revokes its own device, and reads a token already gone as already revoked', async () => {
    const { vaultId, deviceToken } = await ownVault('Leaving')
    const self = h.clientOn(deviceToken)

    expect(await self.revokeSelf()).toBe('revoked')
    const after = await h
      .clientFor(deviceToken, vaultId)
      .state()
      .catch((e: unknown) => e)
    expect((after as AbeleError).code).toBe('unauthorized')
    // Asked again, the server refuses the token: the device is gone either way.
    expect(await self.revokeSelf()).toBe('already')
  })

  it('reads a device an account revoked as already revoked', async () => {
    const { vaultId } = await h.vault(accountToken, 'Revoked by the owner')
    const { deviceId, deviceToken } = await h.device(accountToken, vaultId, 'taken away')
    await h.clientOn(accountToken).revokeDevice(deviceId)
    expect(await h.clientOn(deviceToken).revokeSelf()).toBe('already')
  })

  it('does not read a stranger refusing the token as the server having revoked it', async () => {
    const { deviceToken } = await ownVault('Door')
    const door: typeof fetch = () =>
      Promise.resolve(
        new Response('<html>sign in</html>', {
          status: 401,
          headers: { 'content-type': 'text/html' },
        })
      )
    const error = await h
      .clientOn(deviceToken, { fetch: door })
      .revokeSelf()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EngineError)
    expect((error as EngineError).code).toBe('unauthorized')
  })

  it('sends no revoke for a token that is not a device token, and never calls it already', async () => {
    let calls = 0
    const counting: typeof fetch = () => {
      calls++
      return Promise.reject(new Error('no request should have been made'))
    }
    for (const token of ['', 'abst_an-account-token', 'not-a-token', ' absd_']) {
      const error = await h
        .clientOn(token, { fetch: counting })
        .revokeSelf()
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(EngineError)
      expect((error as EngineError).code).toBe('unauthorized')
    }
    expect(calls).toBe(0)
  })

  it('calls a revoke that never reached the server offline, and a server fault an error', async () => {
    const { vaultId, deviceToken } = await ownVault('Unreachable')
    const offline = await h
      .clientOn(deviceToken, { fetch: () => Promise.reject(new TypeError('fetch failed')) })
      .revokeSelf()
      .catch((e: unknown) => e)
    expect(offline).toBeInstanceOf(EngineError)
    expect((offline as EngineError).code).toBe('offline')

    const broken: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'internal', message: 'down' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      )
    const fault = await h
      .clientOn(deviceToken, { fetch: broken })
      .revokeSelf()
      .catch((e: unknown) => e)
    expect(fault).toBeInstanceOf(Error)
    expect(fault).not.toBeInstanceOf(EngineError)
    // And the device is still live: nothing was revoked.
    await expect(h.clientFor(deviceToken, vaultId).state()).resolves.toBeDefined()
  })

  it('enrols a sibling device on its own vault, with a token of its own', async () => {
    const { vaultId } = await h.vault(accountToken, 'Siblings')
    const { deviceId, deviceToken } = await h.device(accountToken, vaultId, 'Laptop')
    const sibling = await h.clientOn(deviceToken).enrolSibling('Phone', 'mobile')

    expect(sibling.device_token).toMatch(/^absd_/)
    expect(sibling.device_token).not.toBe(deviceToken)
    await expect(h.clientFor(sibling.device_token, vaultId).state()).resolves.toBeDefined()
    const listed = await h.clientOn(accountToken).listDevices()
    expect(listed.find((d) => d.id === sibling.device_id)).toMatchObject({
      name: 'Phone',
      platform: 'mobile',
      vault_id: vaultId,
      enrolled_by: deviceId,
    })
  })

  it("lists its vault's devices and revokes another of them, but not itself", async () => {
    const { vaultId } = await h.vault(accountToken, 'Device list')
    const laptop = await h.device(accountToken, vaultId, 'Laptop')
    const phone = await h.device(accountToken, vaultId, 'Phone')
    const client = h.clientFor(laptop.deviceToken, vaultId)

    // Oldest first; two enrolled in one millisecond may come either way.
    const listed = await client.listVaultDevices()
    expect(listed.map((d) => [d.id, d.name]).sort()).toEqual(
      [
        [laptop.deviceId, 'Laptop'],
        [phone.deviceId, 'Phone'],
      ].sort()
    )

    await client.revokeVaultDevice(phone.deviceId)
    // Asked again it is done already, which is no error.
    await client.revokeVaultDevice(phone.deviceId)
    expect((await client.listVaultDevices()).map((d) => d.id)).toEqual([laptop.deviceId])
    const gone = await h
      .clientFor(phone.deviceToken, vaultId)
      .state()
      .catch((e: unknown) => e)
    expect((gone as AbeleError).code).toBe('unauthorized')

    const self = await client.revokeVaultDevice(laptop.deviceId).catch((e: unknown) => e)
    expect((self as AbeleError).code).toBe('conflict')
    const stranger = await client.revokeVaultDevice('no-such-device').catch((e: unknown) => e)
    expect((stranger as AbeleError).code).toBe('not_found')
    await expect(client.state()).resolves.toBeDefined()
  })

  it('calls a body that stops arriving offline, not a protocol fault', async () => {
    const { vaultId, deviceToken } = await ownVault('Torn')
    /** A connection that gets the headers out and then goes. */
    const torn: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('connection reset'))
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    const client = h.clientFor(deviceToken, vaultId, { fetch: torn })

    // Asked one at a time: a promise made ahead and rejected before it is awaited is an
    // unhandled rejection the runner may or may not catch.
    for (const ask of [() => client.state(), () => client.getBlob('b'.repeat(64))]) {
      const error = await ask().catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(EngineError)
      expect((error as EngineError).code).toBe('offline')
    }
  })

  it('calls a request that never reached the server offline', async () => {
    const { vaultId, deviceToken } = await ownVault('Offline')
    const dead = new TypeError('fetch failed')
    const client = h.clientFor(deviceToken, vaultId, { fetch: () => Promise.reject(dead) })

    const error = await client.state().catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(EngineError)
    expect((error as EngineError).code).toBe('offline')
    expect((error as EngineError).cause).toBe(dead)
  })

  it('hears the sequence a commit moved the vault to, and stops listening when told', async () => {
    const { vaultId, client } = await ownVault('Events')
    const heard: number[] = []
    const closes: string[] = []
    const stop = client.subscribe(
      (headSeq) => heard.push(headSeq),
      (why) => closes.push(why)
    )

    await until(() => h.hub.sockets(vaultId) === 1, 'the server to take the hello')
    const committed = await client.commit(
      [await create(client, 'notes/live.md', 'live')],
      'events-1'
    )
    await until(() => heard.length > 0, 'a seq frame')
    expect(heard.at(-1)).toBe(committed.head_seq)

    stop()
    await until(() => h.hub.sockets(vaultId) === 0, 'the socket to go')
    // Hanging up is not something the caller needs telling about; it asked.
    expect(closes).toEqual([])
  })
})
