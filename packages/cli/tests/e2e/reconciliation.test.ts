import { afterEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { v2Server, type V2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { runCli } from '../../src/cli.js'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { SqliteStateStore } from '@abele/sync-node'
import { StateTransaction } from '@abele/sync-core'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'

let server: V2Server | undefined
let scratch: string | undefined
const invoke = async (args: string[], env: NodeJS.ProcessEnv = {}, fetchImpl = fetch) => {
  const out: string[] = [],
    err: string[] = []
  const code = await runCli(args, env, {
    fetch: fetchImpl,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
async function fixture() {
  server = await v2Server()
  const root = await createUser(
    { db: server.db, pepper: server.config.tokenPepper, dialect: 'sqlite' },
    'CLI fixture',
    server.address
  )
  await mkdir(resolve('.scratch'), { recursive: true })
  scratch = await mkdtemp(join(resolve('.scratch'), 'cli-token-'))
  const a = join(scratch, 'A')
  await mkdir(a)
  return { root, a }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  server = undefined
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = undefined
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  uptime: () => 100000,
}))

describe('restored vault recovery', () => {
  it('fences a new generation before startup can replay a restored destructive journal', async () => {
    const { root, a } = await fixture()
    expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).toBe(0)
    await writeFile(join(a, 'Note.bin'), 'server variant')
    await writeFile(join(a, 'Keep.bin'), 'keep remotely')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const backup = join(server!.dir, 'combined-cli.db')
    await sql.raw(`vacuum into '${backup.replaceAll("'", "''")}'`).execute(server!.db)
    const remote = new V2SyncClient(root.token)
    await remote.create('Advanced.bin', 'advanced')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const state = SqliteStateStore.open(join(a, '.abele-sync', 'state.db'))
    const entry = (await state.get('Keep.bin'))!
    const oldGeneration = state.getMeta('server-restore-generation')
    await state.setJournal({
      batchId: randomUUID(),
      idempotencyKey: randomUUID(),
      startedAt: new Date().toISOString(),
      ops: [{ op: 'delete', file_id: entry.fileId, base_version_id: entry.versionId }],
    })
    state.close()
    await writeFile(join(a, 'Note.bin'), 'restored local edit')
    await utimes(join(a, 'Note.bin'), 1, 1)
    await rm(join(a, 'Keep.bin'))
    await server!.restart(async () => {
      await cp(backup, join(server!.dir, 'server.db'))
    })
    const result = await invoke(['run', '--dir', a, '--once'])
    expect(result.code, result.err).toBe(0)
    const status = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
    expect(status.reconciliation.phase).toBe('complete')
    expect(status.reconciliation.reason).toContain('generation')
    const items = (await remote.manifest()).items.filter((i) => i.kind !== 'directory')
    const bytes = await Promise.all(
      items.map(async (i) => (await remote.content(i.file_id)).toString())
    )
    expect(bytes.sort()).toEqual([
      'advanced',
      'keep remotely',
      'restored local edit',
      'server variant',
    ])
    const local = await Promise.all(items.map((i) => readFile(join(a, i.path), 'utf8')))
    expect(local.sort()).toEqual(bytes.sort())
    const reopened = SqliteStateStore.open(join(a, '.abele-sync', 'state.db'))
    expect(reopened.getMeta(`retired-generation:${oldGeneration}`)).toContain(entry.fileId)
    expect(await reopened.getJournal()).toBeNull()
    reopened.close()
    expect(
      await server!.db.selectFrom('versions').select('id').where('op', '=', 'delete').execute()
    ).toEqual([])
  })
  it('holds three historical absences without allowing directory publication to bypass file review', async () => {
    const { root, a } = await fixture()
    expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).toBe(0)
    await mkdir(join(a, 'Missing'))
    for (let i = 0; i < 3; i++) await writeFile(join(a, 'Missing', `${i}.bin`), `keep ${i}`)
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const remote = new V2SyncClient(root.token)
    const before = (await remote.manifest()).items.filter((i) => i.path.startsWith('Missing/'))
    await remote.create('Advanced.bin', 'advanced')
    await rm(join(a, 'Missing'), { recursive: true })
    const result = await invoke(['run', '--dir', a, '--once'])
    expect(result.code, result.err).toBe(0)
    const status = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
    expect(status.heldDeletes.map((h: { path: string }) => h.path).sort()).toEqual([
      'Missing/0.bin',
      'Missing/1.bin',
      'Missing/2.bin',
    ])
    const after = (await remote.manifest()).items.filter((i) => i.path.startsWith('Missing/'))
    expect(after).toEqual(before)
    for (let i = 0; i < 3; i++)
      expect(
        (
          await remote.content(after.find((item) => item.path === `Missing/${i}.bin`)!.file_id)
        ).toString()
      ).toBe(`keep ${i}`)
    expect((await invoke(['deletes', '--dir', a, '--restore'])).code).toBe(0)
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    for (let i = 0; i < 3; i++)
      expect(await readFile(join(a, 'Missing', `${i}.bin`), 'utf8')).toBe(`keep ${i}`)
  })
  it('keeps the causally newer remote binary even when its clock is behind restored local bytes', async () => {
    const { root, a } = await fixture()
    expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).toBe(0)
    await writeFile(join(a, 'Note.bin'), 'base')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const remote = new V2SyncClient(root.token)
    const note = (await remote.manifest()).items.find((i) => i.path === 'Note.bin')!
    const blob = await remote.upload(Buffer.from('causally newer remote'))
    await remote.commit([
      { op: 'modify', file_id: note.file_id, base_version_id: note.version_id, ...blob, mtime: 0 },
    ])
    await writeFile(join(a, 'Note.bin'), 'restored edit')
    await utimes(join(a, 'Note.bin'), 1, 1)
    const result = await invoke(['run', '--dir', a, '--once'])
    expect(result.code, result.err).toBe(0)
    const items = (await remote.manifest()).items
    const bytes = await Promise.all(
      items.map(async (i) => (await remote.content(i.file_id)).toString())
    )
    expect(bytes.sort()).toEqual(['causally newer remote', 'restored edit'])
    const local = await Promise.all(
      (await readdir(a)).filter((p) => p.endsWith('.bin')).map((p) => readFile(join(a, p), 'utf8'))
    )
    expect(local.sort()).toEqual(['causally newer remote', 'restored edit'])
  })
  it.each(['before request', 'after commit before reply', 'after reply before ledger'])(
    'resumes restored-backup reconciliation interrupted %s without duplicate copies or lost bytes',
    async (boundary) => {
      const { root, a } = await fixture()
      expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).toBe(0)
      await writeFile(join(a, 'Note.bin'), 'base')
      await writeFile(join(a, 'Absent.bin'), 'keep remotely')
      expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
      const remote = new V2SyncClient(root.token)
      const note = (await remote.manifest()).items.find((i) => i.path === 'Note.bin')!
      const blob = await remote.upload(Buffer.from('remote'))
      await remote.commit([
        {
          op: 'modify',
          file_id: note.file_id,
          base_version_id: note.version_id,
          ...blob,
          mtime: Date.now() + 1000,
        },
      ])
      await writeFile(join(a, 'Note.bin'), 'restored')
      await utimes(join(a, 'Note.bin'), 1, 1)
      await rm(join(a, 'Absent.bin'))
      let failed = false
      let receivedReply = false
      let failedLedgerWrite = false
      const transport: typeof fetch = async (input, init) => {
        if (!failed && String(input).endsWith('/v2/commit') && init?.method === 'POST') {
          failed = true
          if (boundary === 'before request') throw new Error('interrupted before request')
          if (boundary === 'after commit before reply') {
            await fetch(input, init)
            throw new Error('lost reply')
          }
          if (boundary === 'after reply before ledger') {
            const reply = await fetch(input, init)
            receivedReply = true
            return reply
          }
        }
        return fetch(input, init)
      }
      if (boundary === 'after reply before ledger') {
        const put = StateTransaction.prototype.put
        vi.spyOn(StateTransaction.prototype, 'put').mockImplementation(async function (
          this: StateTransaction,
          entry
        ) {
          if (receivedReply && !failedLedgerWrite) {
            failedLedgerWrite = true
            throw new Error('interrupted ledger write')
          }
          await put.call(this, entry)
        })
      }
      expect((await invoke(['run', '--dir', a, '--once'], {}, transport)).code).not.toBe(0)
      if (boundary === 'after reply before ledger') expect(failedLedgerWrite).toBe(true)
      vi.restoreAllMocks()
      const retry = await invoke(['run', '--dir', a, '--once'])
      expect(retry.code, retry.err).toBe(0)
      const status = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
      expect(status.heldDeletes.map((h: { path: string }) => h.path)).toEqual(['Absent.bin'])
      const items = (await remote.manifest()).items
      expect(items).toHaveLength(3)
      const bytes = await Promise.all(
        items.map(async (i) => (await remote.content(i.file_id)).toString())
      )
      expect(bytes.sort()).toEqual(['keep remotely', 'remote', 'restored'])
      const local = await Promise.all(
        (await readdir(a))
          .filter((p) => p.endsWith('.bin'))
          .map((p) => readFile(join(a, p), 'utf8'))
      )
      expect(local.sort()).toEqual(['remote', 'restored'])
    }
  )

  it('eventually publishes a same-size same-mtime edit without an explicit reconciliation', async () => {
    const { root, a } = await fixture()
    expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).toBe(0)
    await writeFile(join(a, 'Same.bin'), 'old')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const state = SqliteStateStore.open(join(a, '.abele-sync', 'state.db'))
    const entry = (await state.get('Same.bin'))!
    state.close()
    await writeFile(join(a, 'Same.bin'), 'new')
    await utimes(join(a, 'Same.bin'), entry.mtime / 1000, entry.mtime / 1000)
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const remote = new V2SyncClient(root.token)
    expect((await remote.content(entry.fileId)).toString()).toBe('new')
    expect(await readFile(join(a, 'Same.bin'), 'utf8')).toBe('new')
  })
  it('does not replay a restored profile destructive journal against an advanced server', async () => {
    const { root, a } = await fixture()
    const remote = new V2SyncClient(root.token)
    const connected = await invoke(['connect', '--dir', a, '--token', root.token])
    expect(connected.code, connected.err).toBe(0)
    await writeFile(join(a, 'Keep.bin'), 'remote survivor')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const snapshot = join(scratch!, 'profile-backup')
    await cp(join(a, '.abele-sync'), snapshot, { recursive: true })
    const state = SqliteStateStore.open(join(snapshot, 'state.db'))
    const entry = (await state.get('Keep.bin'))!
    const key = randomUUID()
    await state.setJournal({
      batchId: randomUUID(),
      idempotencyKey: key,
      startedAt: new Date().toISOString(),
      ops: [{ op: 'delete', file_id: entry.fileId, base_version_id: entry.versionId }],
    })
    await state.setMeta(
      'delete-decision',
      JSON.stringify({ kind: 'confirm', fileIds: [entry.fileId], at: new Date().toISOString() })
    )
    state.close()
    await remote.create('Advanced.bin', 'newer server bytes')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    await rm(join(a, '.abele-sync'), { recursive: true })
    await cp(snapshot, join(a, '.abele-sync'), { recursive: true })
    await rm(join(a, 'Keep.bin'))
    await writeFile(join(a, 'Local.bin'), 'restored unsent edit')
    const result = await invoke(['run', '--dir', a, '--once'])
    expect(result.code, result.err).toBe(0)
    const status = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
    expect(status.reconciliation.phase).toBe('review')
    expect(status.heldDeletes.map((h: { path: string }) => h.path)).toEqual(['Keep.bin'])
    const items = (await remote.manifest()).items
    const bytes = await Promise.all(
      items.map(async (i) => (await remote.content(i.file_id)).toString())
    )
    expect(bytes.sort()).toEqual(
      ['newer server bytes', 'remote survivor', 'restored unsent edit'].sort()
    )
    expect(await readFile(join(a, 'Advanced.bin'), 'utf8')).toBe('newer server bytes')
    expect(await readFile(join(a, 'Local.bin'), 'utf8')).toBe('restored unsent edit')
    const reopened = SqliteStateStore.open(join(a, '.abele-sync', 'state.db'))
    expect(reopened.getMeta(`reconciliation-journal:${key}`)).toContain(entry.fileId)
    expect(await reopened.getJournal()).toBeNull()
    reopened.close()
    // The review is durable across processes, then the ordinary restore decision resolves it.
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    expect((await invoke(['deletes', '--dir', a, '--restore'])).code).toBe(0)
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    expect(await readFile(join(a, 'Keep.bin'), 'utf8')).toBe('remote survivor')
    const done = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
    expect(done.reconciliation.phase).toBe('complete')
    expect(done.heldDeletes).toEqual([])
  })

  it('exposes an explicit full reconciliation command that holds a single delete', async () => {
    const { root, a } = await fixture()
    expect((await invoke(['connect', '--dir', a, '--token', root.token])).code).toBe(0)
    await writeFile(join(a, 'Keep.bin'), 'keep')
    await writeFile(join(a, 'Same.bin'), 'old')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    const state = SqliteStateStore.open(join(a, '.abele-sync', 'state.db'))
    const entry = (await state.get('Same.bin'))!
    state.close()
    await writeFile(join(a, 'Same.bin'), 'new')
    await utimes(join(a, 'Same.bin'), entry.mtime / 1000, entry.mtime / 1000)
    await rm(join(a, 'Keep.bin'))
    const result = await invoke(['reconcile', '--dir', a])
    expect(result.code, result.err).toBe(0)
    const status = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
    expect(status.heldDeletes.map((h: { path: string }) => h.path)).toEqual(['Keep.bin'])
    const remote = new V2SyncClient(root.token)
    const same = (await remote.manifest()).items.find((i) => i.path === 'Same.bin')!
    expect((await remote.content(same.file_id)).toString()).toBe('new')
  })

  it('reconciles restored disk bytes and holds even one historical absence against an advanced server', async () => {
    const { root, a } = await fixture()
    const remote = new V2SyncClient(root.token)
    const connected = await invoke(['connect', '--dir', a, '--token', root.token])
    expect(connected.code, connected.err).toBe(0)
    await writeFile(join(a, 'Note.bin'), 'current local')
    await writeFile(join(a, 'Absent.bin'), 'keep remotely')
    expect((await invoke(['run', '--dir', a, '--once'])).code).toBe(0)
    await writeFile(join(a, 'Note.bin'), 'restored edit')
    await utimes(join(a, 'Note.bin'), 1, 1)
    await rm(join(a, 'Absent.bin'))
    const note = (await remote.manifest()).items.find((i) => i.path === 'Note.bin')!
    const blob = await remote.upload(Buffer.from('newer remote'))
    await remote.commit([
      {
        op: 'modify',
        file_id: note.file_id,
        base_version_id: note.version_id,
        ...blob,
        mtime: Date.now() + 1000,
      },
    ])
    const result = await invoke(['run', '--dir', a, '--once'])
    expect(result.code, result.err).toBe(0)
    const status = JSON.parse((await invoke(['status', '--dir', a, '--json'])).out)
    expect(status.reconciliation.phase).toBe('review')
    expect(status.heldDeletes.map((h: { path: string }) => h.path)).toContain('Absent.bin')
    const items = (await remote.manifest()).items.filter((i) => i.kind !== 'directory')
    const bytes = await Promise.all(
      items.map(async (i) => (await remote.content(i.file_id)).toString())
    )
    expect(bytes).toContain('restored edit')
    expect(bytes).toContain('newer remote')
    expect(bytes).toContain('keep remotely')
    const local = await Promise.all(
      (await readdir(a)).filter((p) => p.endsWith('.bin')).map((p) => readFile(join(a, p), 'utf8'))
    )
    expect(local).toContain('restored edit')
    expect(local).toContain('newer remote')
  })
})
