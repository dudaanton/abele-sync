import { describe, expect, it } from 'vitest'
import { readScopedCurrent } from '../../src/scoped/content.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
for (const dialect of ['sqlite', 'pg'] as const) {
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`scoped content privacy (${dialect})`, () => {
    it('reads 65 identical admissible files by SHA and gives generic misses for policy-forbidden hashes', async () => {
      const f = await scopedFixture(dialect)
      try {
        const sha = await putBlob(f.t.app, f.device.deviceToken, 'same')
        await commit(
          f.t.app,
          f.device.deviceToken,
          f.vault,
          Array.from({ length: 65 }, (_, i) => create(`Agents/file-${i}.md`, 'same'))
        )
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        const get = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { sha },
          { method: 'GET' }
        )
        expect(get.body?.toString()).toBe('same')
        const forbidden = { ...f.deps, configurationDirectories: ['Agents'] }
        const ask = (hash: string) =>
          readScopedCurrent(
            forbidden,
            f.a.key_token,
            f.vault,
            f.grant.id,
            { sha: hash },
            { method: 'HEAD' }
          ).catch((error) => error.toBody())
        expect(await ask(sha)).toEqual(await ask('a'.repeat(64)))
        expect((await ask(sha)).error.code).toBe('not_found')
      } finally {
        await f.close()
      }
    })
    it('returns full new content when If-Range is stale instead of splicing tails from different versions', async () => {
      const f = await scopedFixture(dialect)
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'old-content')
        const first = (
          await commit(f.t.app, f.device.deviceToken, f.vault, [
            create('Agents/note.md', 'old-content'),
          ])
        ).results[0]
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        await putBlob(f.t.app, f.device.deviceToken, 'new-content')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          {
            op: 'modify',
            file_id: first.file_id,
            base_version_id: first.version_id,
            sha: shaOf('new-content'),
            size: 11,
            mtime: 2,
          },
        ])
        const stale = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { file_id: first.file_id },
          { method: 'GET', range: 'bytes=4-', ifRange: `"${shaOf('old-content')}"` }
        )
        expect(stale.status).toBe(200)
        expect(stale.body?.toString()).toBe('new-content')
        const valid = await readScopedCurrent(
          f.deps,
          f.a.key_token,
          f.vault,
          f.grant.id,
          { file_id: first.file_id },
          { method: 'GET', range: 'bytes=4-', ifRange: `"${shaOf('new-content')}"` }
        )
        expect(valid.status).toBe(206)
        expect(valid.body?.toString()).toBe('content')
      } finally {
        await f.close()
      }
    })
  })
}
