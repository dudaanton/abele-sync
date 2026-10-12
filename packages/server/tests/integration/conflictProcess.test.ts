import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { buildTestApp } from '../helpers/testApp.js'
import { commit, create, putBlob, shaOf } from '../helpers/ops.js'
import { createDb } from '../../src/db/connect.js'
import { commit as directCommit } from '../../src/oplog/commit.js'

it.each(['race', 'held-writer'])(
  'deduplicates independent SQLite processes with stale snapshots (%s) and rolls back real crashes before commit; after-commit retries preserve identity',
  async (race) => {
    const t = await buildTestApp()
    const children: ChildProcess[] = []
    let shared: ReturnType<typeof createDb> | undefined
    const launch = (args: string[]) => {
      const child = fork(new URL('../helpers/conflictCommitChild.mjs', import.meta.url), args, {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      })
      children.push(child)
      return child
    }
    const message = async (child: ChildProcess): Promise<any> => {
      const [value] = await once(child, 'message')
      if (value.error)
        throw new Error(`${value.code ?? 'child failure'}: ${value.error}\n${value.stack ?? ''}`)
      return value
    }
    try {
      const account = (await t.account()).accountToken
      const vault = (await t.vault(account)).vaultId
      const device = await t.device(account, vault)
      for (const text of ['base\n', 'head\n', 'incoming\n', 'crash\n', 'landed\n'])
        await putBlob(t.app, device.deviceToken, text)
      const made = (await commit(t.app, device.deviceToken, vault, [create('N.md', 'base\n')]))
        .results[0]
      const op = (text: string) => ({
        op: 'modify' as const,
        file_id: made.file_id,
        base_version_id: made.version_id,
        sha: shaOf(text),
        size: text.length,
        mtime: 5,
      })
      await commit(t.app, device.deviceToken, vault, [op('head\n')])
      const file = join(t.dir, 'shared.db')
      await sql.raw(`vacuum into '${file.replace(/'/g, "''")}'`).execute(t.db)
      const url = `sqlite://${file}`
      shared = createDb(url)
      const child = (name: string, text: string, mode: string) =>
        launch([url, t.store.dir, vault, name, JSON.stringify(op(text)), mode])
      const racers = [
        child('one', 'incoming\n', race === 'held-writer' ? 'race-hold' : 'race'),
        child('two', 'incoming\n', race === 'held-writer' ? 'race-retry' : 'race'),
      ]
      expect(await Promise.all(racers.map(message))).toEqual([
        { phase: 'snapshot' },
        { phase: 'snapshot' },
      ])
      const exits = racers.map((c) => once(c, 'exit'))
      if (race === 'held-writer') {
        const written = message(racers[0]!)
        racers[0]!.send('go')
        expect(await written).toEqual({ phase: 'rows-written' })
        const retried = message(racers[1]!)
        racers[1]!.send('go')
        expect(await retried).toEqual({ phase: 'retry-budget' })
      }
      const answers = racers.map(message)
      racers.forEach((c) => c.send('go'))
      const result = (await Promise.all(answers)).map((r) => r.response.results[0])
      await Promise.all(exits)
      expect(result[0].status).toBe('conflict')
      expect(result[0]).toEqual(result[1])
      expect(await shared.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(
        1
      )
      expect(
        await shared.db.selectFrom('versions').select('id').where('op', '=', 'conflict').execute()
      ).toHaveLength(1)
      expect(await shared.db.selectFrom('idempotency').select('key').execute()).toHaveLength(2)
      const before = child('crash-before', 'crash\n', 'before-commit')
      expect(await message(before)).toEqual({ phase: 'rows-written' })
      const dead = once(before, 'exit')
      before.kill('SIGKILL')
      await dead
      expect(await shared.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(
        1
      )
      const retry = async (text: string) =>
        (
          await directCommit(
            { db: shared!.db, dialect: 'sqlite', store: t.store, hub: t.hub },
            vault,
            { kind: 'device', id: device.deviceId, name: 'retry' },
            [op(text)]
          )
        ).results[0]
      expect((await retry('crash\n'))!.status).toBe('conflict')
      const after = child('crash-after', 'landed\n', 'after-commit')
      expect(await message(after)).toEqual({ phase: 'committed' })
      const died = once(after, 'exit')
      after.kill('SIGKILL')
      await died
      const landed = await shared.db
        .selectFrom('conflict_divergences')
        .selectAll()
        .where('incoming_sha', '=', shaOf('landed\n'))
        .executeTakeFirstOrThrow()
      expect(await retry('landed\n')).toMatchObject({
        status: 'conflict',
        conflict_file_id: landed.conflict_file_id,
      })
      expect(await shared.db.selectFrom('conflict_divergences').selectAll().execute()).toHaveLength(
        3
      )
      expect(
        await shared.db.selectFrom('versions').select('id').where('op', '=', 'conflict').execute()
      ).toHaveLength(3)
      const referenced = await shared.db.selectFrom('blobs').select(['sha', 'refs']).execute()
      for (const row of referenced) {
        const versions = await shared.db
          .selectFrom('versions')
          .select('id')
          .where('blob_sha', '=', row.sha)
          .execute()
        expect(row.refs).toBe(versions.length)
      }
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }
      await shared?.close()
      await t.close()
    }
  },
  30_000
)
