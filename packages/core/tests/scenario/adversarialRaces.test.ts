import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adversarial, type Adversarial } from '../helpers/adversarial.js'
import { converge } from '../helpers/device.js'
import { shaOf } from '../helpers/seed.js'
import { EngineError } from '../../src/index.js'
import { TEST_PASSWORD } from '../helpers/harness.js'

let t: Adversarial
beforeEach(async () => {
  t = await adversarial()
})
afterEach(async () => {
  try {
    await t.close()
  } finally {
    vi.useRealTimers()
  }
})

describe('Adversarial: late edits and recovery', () => {
  for (const kind of ['note', 'attachment', 'settings', 'move'] as const) {
    // Regression B1: a verdict download must not overwrite a later edit.
    it(`B1 preserves typing during ${kind} verdict download`, async () => {
      const a = await t.device('a'),
        b = await t.device('b')
      const path =
        kind === 'attachment' ? 'image.bin' : kind === 'settings' ? '.obsidian/app.json' : 'note.md'
      await a.write(path, 'one\ntwo\nthree\nfour\nfive\n')
      await converge(a, b)
      await a.write(path, 'ONE\ntwo\nthree\nfour\nfive\n', 200)
      if (kind === 'move') await b.mv(path, 'moved.md')
      else await b.write(path, 'one\ntwo\nthree\nfour\nFIVE\n', 100)
      await a.sync()
      const target = kind === 'move' ? 'moved.md' : path
      let injected = false
      const get = b.client.getBlob.bind(b.client)
      b.client.getBlob = async (sha) => {
        // Awaited inside the real planner, after untouched() and before result placement.
        if (!injected) {
          injected = true
          await b.write(target, 'LATE UNSENT EDIT\n', 300)
        }
        return get(sha)
      }
      await b.sync()
      expect(injected).toBe(true)
      expect(await b.text(target)).toContain('LATE UNSENT EDIT')
      await converge(a, b)
      if (kind === 'note' || kind === 'move') {
        const stem = target.slice(0, -3)
        const copies = a.paths().filter((p) => p.startsWith(`${stem} (Conflicted copy`))
        expect(copies).toHaveLength(1)
        expect(await a.text(copies[0]!)).toBe('LATE UNSENT EDIT\n')
        expect(await a.text(target)).not.toContain('LATE UNSENT EDIT')
      } else expect(await a.text(target)).toContain('LATE UNSENT EDIT')
    })
  }

  it('keeps pending Markdown bytes on copy-quota refusal and delivers them after quota is raised', async () => {
    const a = await t.device('a'),
      b = await t.device('b')
    await a.write('note.md', 'base\n')
    await converge(a, b)
    const head = 'owner content\n',
      incoming = 'guest content\n'
    await a.write('note.md', head)
    await a.sync()
    await t.settings(a.deviceToken, { quota_bytes: 20, account_password: TEST_PASSWORD })
    await b.write('note.md', incoming)
    const refused = await b.sync()
    expect(refused.push.rejected.map((r) => r.code)).toEqual(['quota_exceeded'])
    expect(await b.text('note.md')).toBe(incoming)
    expect((await b.client.manifest(null)).items).toHaveLength(1)
    await t.settings(a.deviceToken, { quota_bytes: 100, account_password: TEST_PASSWORD })
    await b.sync()
    await converge(a, b)
    for (const d of [a, b]) {
      expect(await d.text('note.md')).toBe(head)
      const copies = d.paths().filter((p) => p.startsWith('note (Conflicted copy'))
      expect(copies).toHaveLength(1)
      expect(await d.text(copies[0]!)).toBe(incoming)
    }
  })

  // Regression B8: a quota refusal must be retried when other files free space.
  it('B8 retries unchanged bytes after another device frees quota', async () => {
    const a = await t.device('a'),
      b = await t.device('b')
    await t.settings(a.deviceToken, { quota_bytes: 100, account_password: TEST_PASSWORD })
    await b.write('filler.bin', 'b'.repeat(80))
    await converge(a, b)
    await a.write('waiting.bin', 'a'.repeat(60))
    expect((await a.sync()).push.rejected.map((r) => r.code)).toContain('quota_exceeded')
    await b.rm('filler.bin')
    await b.sync()
    expect((await b.client.manifest(null)).items).toEqual([])
    await a.sync()
    expect((await a.client.manifest(null)).items.map((x) => x.path)).toContain('waiting.bin')
  })

  // Regression B19: equal size and mtime do not prove unchanged bytes.
  it('B19 preserves changed local bytes whose size and mtime stayed the same', async () => {
    const a = await t.device('a'),
      b = await t.device('b')
    await a.write('note.md', 'base\n', 10)
    await converge(a, b)
    const stat = (await b.fs.stat('note.md'))!
    await b.write('note.md', 'mine\n', stat.mtime)
    await a.write('note.md', 'remote\n', 20)
    await a.sync()
    await b.sync()
    // Rolling verification now publishes this edit through normal conflict resolution:
    // the remote head remains at its path and the complete local variant is a copy.
    expect(await b.text('note.md')).toBe('remote\n')
    const copies = b.paths().filter((path) => path.startsWith('note (Conflicted copy'))
    expect(copies).toHaveLength(1)
    expect(await b.text(copies[0]!)).toBe('mine\n')
    const items = (await b.client.manifest(null)).items
    const bytes = await Promise.all(items.map((item) => b.client.getBlob(item.sha)))
    expect(bytes.map((value) => new TextDecoder().decode(value)).sort()).toEqual([
      'mine\n',
      'remote\n',
    ])
  })

  it('lost commit reply within TTL replays once and leaves no duplicate history', async () => {
    const a = await t.device('a')
    await a.write('note.md', 'survives')
    const commit = a.client.commitRaw.bind(a.client)
    a.client.commitRaw = async (ops, key) => {
      await commit(ops, key)
      throw new EngineError('offline', 'reply lost after apply')
    }
    await expect(a.sync()).rejects.toThrow('reply lost after apply')
    expect(await a.state.getJournal()).not.toBeNull()
    const revived = t.revive(a)
    await revived.sync()
    expect(await revived.state.getJournal()).toBeNull()
    const entry = (await revived.state.get('note.md'))!
    expect(await revived.client.versions(entry.fileId)).toHaveLength(1)
    expect((await revived.sync()).push.committed).toBeNull()
  })

  // Regression B6: stopping during a blocked read must not wait on its response.
  it('B6 stop cancels an in-flight request rather than waiting for the server', async () => {
    const a = await t.device('a')
    let release!: () => void, entered!: () => void
    const barrier = new Promise<void>((r) => {
      release = r
    })
    const reached = new Promise<void>((r) => {
      entered = r
    })
    const state = a.client.state.bind(a.client)
    a.client.state = async () => {
      entered()
      await barrier
      return state()
    }
    const running = a.sync()
    await reached
    const stopping = a.engine.stop().then(() => 'stopped' as const)
    // Give cancellation one event-loop turn while the request remains blocked; no clock threshold.
    const outcome = await Promise.race([
      stopping,
      new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
    ])
    release()
    await expect(running).rejects.toMatchObject({ code: 'offline' })
    await stopping
    expect(outcome).toBe('stopped')
  })
})

describe('Adversarial: expired journal', () => {
  // Regression B7: an expired join must not replace a newer head.
  it('B7 does not overwrite a newer head when a lost join reply is retried after 25 hours', async () => {
    await t.close()
    let now = new Date('2026-01-01T00:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    t = await adversarial({ now: () => now })
    const b = await t.device('b')
    await b.write('note.md', 'server seed\n')
    await b.sync()
    const a = await t.device('a', { joinPrefer: 'mine' })
    await a.write('note.md', 'old join content\n')
    const commit = a.client.commitRaw.bind(a.client)
    a.client.commitRaw = async (ops, key) => {
      await commit(ops, key)
      throw new EngineError('offline', 'join reply lost')
    }
    await expect(a.sync()).rejects.toThrow('join reply lost')
    const journal = (await a.state.getJournal())!
    expect(journal.startedAt).toBe(now.toISOString())
    expect(
      await t.h.db
        .selectFrom('idempotency')
        .select('key')
        .where('key', '=', journal.idempotencyKey)
        .execute()
    ).toHaveLength(1)
    // Older servers discarded replies after their TTL: reproduce that state explicitly.
    await t.h.db.deleteFrom('idempotency').where('key', '=', journal.idempotencyKey).execute()
    expect(
      await t.h.db
        .selectFrom('idempotency')
        .select('key')
        .where('key', '=', journal.idempotencyKey)
        .execute()
    ).toEqual([])
    await b.sync()
    await b.write('note.md', 'newer remote content\n')
    await b.sync()
    now = new Date(now.getTime() + 25 * 60 * 60 * 1000)
    vi.setSystemTime(now)
    const revived = t.revive(a, { joinPrefer: 'mine' })
    const replay = vi.spyOn(revived.client, 'commitRaw')
    await revived.sync()
    expect(await revived.state.getJournal()).toBeNull()
    expect(
      replay.mock.calls.every(([ops]) =>
        ops.every((op) => op.op === 'create' && op.prefer === undefined)
      )
    ).toBe(true)
    await converge(b, revived)
    const copies = revived.paths().filter((path) => path.startsWith('note (Conflicted copy'))
    expect(copies).toHaveLength(1)
    expect(await revived.text(copies[0]!)).toBe('old join content\n')
    expect(await revived.text('note.md')).toBe('newer remote content\n')
    const head = (await b.client.manifest(null)).items.find((item) => item.path === 'note.md')!
    expect(head.sha).toBe(await shaOf('newer remote content\n'))
  })
})
