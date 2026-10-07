import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from 'abele-sync/src/cli.js'
import { prepareFolderAdmissions } from '../../src/scoped/admissions.js'
import { scopedFixture } from '../helpers/scopedFixture.js'
import { liveScopedServer } from '../helpers/liveScopedServer.js'
import { hasPgTestDb } from '../helpers/tempDb.js'
import { commit, create, putBlob } from '../helpers/ops.js'

for (const dialect of ['sqlite', 'pg'] as const)
  describe.skipIf(dialect === 'pg' && !hasPgTestDb)(`agent key revocation (${dialect})`, () => {
    it('stops the real daemon on a revoked machine key, keeps local data, and reports terminal status offline', async () => {
      const f = await scopedFixture(dialect),
        live = await liveScopedServer(f)
      await mkdir(resolve(process.cwd(), 'data'), { recursive: true })
      const dir = await mkdtemp(join(resolve(process.cwd(), 'data'), 'revoked-agent-'))
      const out: string[] = [],
        err: string[] = []
      const io = {
        out: (line: string) => out.push(line),
        err: (line: string) => err.push(line),
        fetch,
      }
      try {
        await putBlob(f.t.app, f.device.deviceToken, 'owner note')
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Agents/received.md', 'owner note'),
        ])
        await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
        expect(
          await runCli(
            [
              'agent',
              'setup',
              '--dir',
              dir,
              '--server',
              live.base,
              '--vault',
              f.vault,
              '--grant',
              f.grant.id,
              '--principal',
              f.a.key_id,
            ],
            { ABELE_AGENT_TOKEN: f.a.key_token },
            io
          )
        ).toBe(0)
        expect(await runCli(['agent', 'run', '--dir', dir, '--once'], {}, io)).toBe(0)
        await writeFile(join(dir, 'Agents/unsent.md'), 'keep unsent bytes')
        await f.revoke(f.a.key_id)
        expect(await runCli(['agent', 'run', '--dir', dir], {}, io)).toBe(4)
        expect(err.join('\n')).toMatch(/key.*revoked/)
        expect(await readFile(join(dir, '.abele-sync/log'), 'utf8')).toMatch(/key.*revoked/)
        expect(await readFile(join(dir, 'Agents/received.md'), 'utf8')).toBe('owner note')
        expect(await readFile(join(dir, 'Agents/unsent.md'), 'utf8')).toBe('keep unsent bytes')
        expect(await f.t.db.selectFrom('files').select('id').execute()).toHaveLength(1)
        const requests = live.requests.length
        expect(
          await runCli(
            ['agent', 'status', '--dir', dir],
            {},
            {
              ...io,
              fetch: async () => {
                throw new Error('offline status')
              },
            }
          )
        ).toBe(0)
        expect(JSON.parse(out.at(-1)!)).toMatchObject({ state: 'revoked', received: 1 })
        expect(live.requests).toHaveLength(requests)
      } finally {
        await rm(dir, { recursive: true, force: true })
        await live.close()
        await f.close()
      }
    })
  })
