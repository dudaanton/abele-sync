import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommitOp } from '@abele/sync-protocol'
import { adversarial, type Adversarial } from '../helpers/adversarial.js'
import { converge } from '../helpers/device.js'
import { blob, seed, shaOf } from '../helpers/seed.js'

let t: Adversarial
beforeEach(async () => {
  t = await adversarial()
})
afterEach(async () => {
  await t.close()
})

describe('pull write provenance', () => {
  for (const cut of ['before-ledger', 'inside-ledger-transaction'] as const) {
    it(`${cut}: records the write before touching disk and clears proof with the recovered ledger`, async () => {
      const a = await t.device('remote'),
        b = await t.device('recovering')
      await a.write('note.md', 'A\n')
      await converge(a, b)
      const base = (await b.state.get('note.md'))!
      await a.write('note.md', 'B\n')
      await a.sync()
      const remote = (await a.state.get('note.md'))!
      const key = `pull-write:${base.fileId}`
      const write = b.fs.writeAtomic.bind(b.fs)
      b.fs.writeAtomic = async (...args) => {
        expect(JSON.parse((await b.state.getMeta(key))!)).toMatchObject({
          fileId: base.fileId,
          versionId: remote.versionId,
          sha: remote.sha,
          target: 'note.md',
          base,
        })
        await write(...args)
      }
      const put = b.state.put.bind(b.state)
      b.state.put = async (entry) => {
        if (cut === 'inside-ledger-transaction') await put(entry)
        throw new Error('crash before ledger commit')
      }
      await expect(b.sync()).rejects.toThrow('crash before ledger commit')
      b.state.put = put
      expect(await b.text('note.md')).toBe('B\n')
      expect(await b.state.get('note.md')).toEqual(base)
      expect(await b.state.getMeta(key)).not.toBeNull()
      const next = t.revive(b)
      const report = await next.sync()
      expect(report.push.committed).toBeNull()
      expect((await next.state.get('note.md'))!.versionId).toBe(remote.versionId)
      expect(await next.state.getMeta(key)).toBeNull()
      expect(await next.client.versions(base.fileId)).toHaveLength(2)
    })
  }

  it('does not adopt typing after a crashed pull, even when size and mtime match its planned write', async () => {
    const a = await t.device('remote'),
      b = await t.device('recovering')
    await a.write('note.md', 'A\n')
    await converge(a, b)
    const base = (await b.state.get('note.md'))!
    await a.write('note.md', 'B\n')
    await a.sync()
    const remote = (await a.state.get('note.md'))!
    const put = b.state.put.bind(b.state)
    b.state.put = async () => {
      throw new Error('crash before ledger commit')
    }
    await expect(b.sync()).rejects.toThrow('crash before ledger commit')
    b.state.put = put
    const key = `pull-write:${base.fileId}`
    expect(await b.state.getMeta(key)).not.toBeNull()
    await b.write('note.md', 'D\n', remote.mtime)
    const next = t.revive(b)
    const commit = next.client.commitRaw.bind(next.client)
    next.client.commitRaw = async (ops, id) => {
      expect(await next.state.get('note.md')).toEqual(base)
      expect(await next.state.getMeta(key)).toBeNull()
      expect(ops[0]).toMatchObject({
        op: 'modify',
        base_version_id: base.versionId,
        sha: await shaOf('D\n'),
      })
      return commit(ops, id)
    }
    expect((await next.sync()).push.merged).toBe(1)
    expect(await next.text('note.md')).toContain('D\n')
    expect(await next.text('note.md')).toContain('B\n')
  })

  it('does not adopt an offline edit matching an intermediate version on an earlier feed page', async () => {
    const a = await t.device('remote'),
      b = await t.device('offline')
    await a.write('note.md', 'A\n')
    await converge(a, b)
    const base = (await b.state.get('note.md'))!
    await b.write('note.md', 'B\n')
    const localMtime = (await b.fs.stat('note.md'))!.mtime
    const modify = async (text: string) =>
      seed(a.client, [
        {
          op: 'modify',
          file_id: base.fileId,
          base_version_id: (await a.client.manifest(null)).items.find(
            (item) => item.file_id === base.fileId
          )!.version_id,
          ...(await blob(a.client, text)),
          mtime: 100,
        },
      ])
    const intermediate = (await modify('B\n')).results[0]!
    if (intermediate.status === 'rejected') throw new Error('fixture rejected')
    // B plus 999 unrelated changes fill one real 1000-item page. C is on the next.
    const filler = await blob(a.client, 'filler\n')
    await seed(
      a.client,
      Array.from({ length: 999 }, (_, i) => ({
        op: 'create',
        path: `filler/${i}.md`,
        ...filler,
        mtime: 1,
      }))
    )
    const latest = (await modify('C\n')).results[0]!
    if (latest.status === 'rejected') throw new Error('fixture rejected')
    const pages: string[][] = []
    const changes = b.client.changes.bind(b.client)
    b.client.changes = async (...args) => {
      const page = await changes(...args)
      pages.push(
        page.items.filter((item) => item.file_id === base.fileId).map((item) => item.version_id)
      )
      return page
    }
    const sent: CommitOp[] = []
    const commit = b.client.commitRaw.bind(b.client)
    b.client.commitRaw = async (ops, key) => {
      sent.push(...ops)
      // A matching historical SHA is not proof that the pull wrote our offline edit.
      expect(await b.state.get('note.md')).toEqual(base)
      expect(await b.text('note.md')).toBe('B\n')
      return commit(ops, key)
    }
    const report = await b.sync()
    expect(pages.slice(0, 2)).toEqual([[intermediate.version_id], [latest.version_id]])
    expect(sent).toEqual([
      {
        op: 'modify',
        file_id: base.fileId,
        base_version_id: base.versionId,
        sha: await shaOf('B\n'),
        size: 2,
        mtime: localMtime,
      },
    ])
    expect(report.push.merged).toBe(1)
    expect(await b.text('note.md')).toContain('B\n')
    expect(await b.text('note.md')).toContain('C\n')
  })
})
