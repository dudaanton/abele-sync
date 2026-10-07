import { expect, it, vi } from 'vitest'
import { serverHarness } from '../helpers/harness.js'
import {
  MemoryStateStore,
  MemoryFileSystem,
  ExpectedWrites,
  encodeText,
  sha256,
  pull,
  push,
  scan,
  resumeJournal,
} from '../../src/index.js'
for (const timing of ['commit', 'download'] as const)
  it(`preserves same-size/same-mtime unsent content during accepted merge ${timing} and later pull`, async () => {
    const t = await serverHarness()
    try {
      const account = await t.account(),
        vault = (await t.vault(account.accountToken)).vaultId,
        one = await t.device(account.accountToken, vault),
        two = await t.device(account.accountToken, vault),
        client = t.clientFor(one.deviceToken, vault),
        other = t.clientFor(two.deviceToken, vault),
        fs = new MemoryFileSystem(),
        state = new MemoryStateStore(),
        expected = new ExpectedWrites(),
        filter = { excluded: () => false }
      const base = 'aaa\nbbb\nccc\n',
        submitted = 'xxx\nbbb\nccc\n',
        remote = 'aaa\nbbb\nyyy\n',
        merged = 'xxx\nbbb\nyyy\n',
        unsent = 'zzz\nbbb\nccc\n',
        path = 'Sample/note.md'
      const upload = async (c: typeof client, text: string) => {
        const bytes = encodeText(text),
          sha = await sha256(bytes)
        await c.putBlob(sha, bytes)
        return { sha, size: bytes.length }
      }
      const first = (
        await client.commit(
          [{ op: 'create', path, ...(await upload(client, base)), mtime: 1 }],
          'sample-baseline'
        )
      ).results[0]!
      if (first.status === 'rejected') throw new Error('baseline rejected')
      await pull(client, fs, state, { filter, dirty: new Set(), expected })
      await fs.writeAtomic(path, encodeText(submitted), 2)
      const found = await scan(fs, state, filter),
        sent = found.ops[0]!
      expect(sent.op).toBe('modify')
      await other.commit(
        [
          {
            op: 'modify',
            file_id: first.file_id,
            base_version_id: first.version_id,
            ...(await upload(other, remote)),
            mtime: 3,
          },
        ],
        'sample-remote'
      )
      let injected = false
      const save = async () => {
        if (!injected) {
          injected = true
          await fs.writeAtomic(path, encodeText(unsent), 2)
        }
      }
      if (timing === 'commit') {
        const commit = client.commitRaw.bind(client)
        vi.spyOn(client, 'commitRaw').mockImplementation(async (...args) => {
          const outcome = await commit(...args)
          await save()
          return outcome
        })
      } else {
        const get = client.getBlob.bind(client),
          hash = await sha256(encodeText(merged))
        vi.spyOn(client, 'getBlob').mockImplementation(async (sha) => {
          const bytes = await get(sha)
          if (sha === hash) await save()
          return bytes
        })
      }
      const report = await push(client, fs, state, found, { expected })
      expect(injected).toBe(true)
      expect(report.committed?.results[0]).toMatchObject({
        status: 'merged',
        sha: await sha256(encodeText(merged)),
      })
      expect(new TextDecoder().decode(await fs.read(path))).toBe(unsent)
      expect(report.kept).toContain(path)
      expect(await state.getJournal()).toBeNull()
      await resumeJournal(client, fs, state, { expected })
      await pull(client, fs, state, { filter, dirty: new Set(), expected })
      expect(new TextDecoder().decode(await fs.read(path))).toBe(unsent)
      expect((await scan(fs, state, filter)).ops).toEqual([
        expect.objectContaining({
          op: 'modify',
          file_id: first.file_id,
          sha: await sha256(encodeText(unsent)),
        }),
      ])
    } finally {
      vi.restoreAllMocks()
      await t.close()
    }
  })
