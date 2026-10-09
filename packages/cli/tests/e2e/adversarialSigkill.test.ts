import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { config } from './helpers/folders.js'
import { writeConfig } from '../../src/config.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnServer, type SpawnedServer } from './helpers/spawnServer.js'
import {
  cleanupFolders,
  withFolderWork,
  waitForFolderWork,
  clientFor,
  converge,
  EMAIL,
  PASSWORD,
  read,
  SETUP_MS,
  syncOnce,
  vaultPair,
  write,
} from './helpers/folders.js'

let server: SpawnedServer
beforeEach(async () => {
  server = await spawnServer()
  await server.createAccount(EMAIL, PASSWORD)
}, SETUP_MS)
afterEach(async () => {
  await waitForFolderWork()
  try {
    await server?.kill()
  } finally {
    await cleanupFolders()
  }
}, SETUP_MS)

async function killAt(dir: string, cut: string, env: NodeJS.ProcessEnv = {}) {
  const child = fork(
    fileURLToPath(new URL('./helpers/adversarialDaemonChild.mjs', import.meta.url)),
    [dir, cut],
    { silent: true, execArgv: [], env: { ...process.env, ...env } }
  )
  const exited = once(child, 'exit')
  let stderr = '',
    timer: ReturnType<typeof setTimeout> | undefined
  child.stderr?.on('data', (x) => {
    stderr += String(x)
  })
  try {
    const message = await Promise.race([
      once(child, 'message').then(([m]) => m),
      exited.then(([code]) => {
        throw new Error(`child ${code}: ${stderr}`)
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no ${cut}: ${stderr}`)), SETUP_MS)
      }),
    ])
    expect(message).toEqual({ barrier: cut })
    child.kill('SIGKILL')
    expect(await exited).toEqual([null, 'SIGKILL'])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
}

describe('Adversarial: real daemon SIGKILL, local files and SQLite state', () => {
  // File transfers can exceed 30 seconds under concurrent full-suite load. Completion
  // is the acknowledged cut and child exit, not elapsed time; SETUP_MS is a safety deadline.
  // BUG: B15 — config is switched before the old vault's ledger is discarded.
  it(
    'B15 restart after switching config to B must walk B instead of trusting cursor A',
    () =>
      withFolderWork(async () => {
        const old = await vaultPair(server, 'old-vault')
        const next = await vaultPair(server, 'new-vault')
        for (let i = 0; i < 5; i++) await write(old.a, `old-${i}.md`, `old ${i}`)
        await converge(old.a, old.b)
        await write(next.a, 'new.md', 'must be downloaded')
        await syncOnce(next.a)
        await killAt(old.b, 'init-config', {
          ABELE_TEST_SERVER: server.url,
          ABELE_TEST_NEXT_VAULT: 'new-vault',
        })
        expect(config(old.b).vaultId).toBe(next.vaultId)
        await syncOnce(old.b)
        expect(await read(old.b, 'new.md').catch(() => null)).toBe('must be downloaded')
      }),
    SETUP_MS
  )

  // BUG: B12 — committed deletes are not tallied in the same durable transaction.
  it(
    'B12 SIGKILL before delete tally must not bypass the rolling 50-delete guard',
    () =>
      withFolderWork(async () => {
        const { a, b } = await vaultPair(server, 'delete-tally')
        for (let i = 0; i < 200; i++) await write(a, `n${i}.md`, `note ${i}`)
        await converge(a, b)
        for (let i = 0; i < 49; i++) await unlink(join(b, `n${i}.md`))
        await killAt(b, 'delete-tally')
        expect((await clientFor(a).manifest(null)).items).toHaveLength(151)
        await unlink(join(b, 'n49.md'))
        await syncOnce(b)
        expect((await clientFor(a).manifest(null)).items).toHaveLength(151)
      }),
    SETUP_MS
  )

  it(
    'merge-result download survives SIGKILL without losing either original',
    () =>
      withFolderWork(async () => {
        const { a, b } = await vaultPair(server, 'merge-kill')
        await write(a, 'note.md', 'one\ntwo\nthree\n')
        await converge(a, b)
        await write(a, 'note.md', 'ONE\ntwo\nthree\n')
        await write(b, 'note.md', 'one\ntwo\nTHREE\n')
        await syncOnce(a)
        await killAt(b, 'merge-download')
        await converge(a, b)
        expect(await read(b, 'note.md')).toBe('ONE\ntwo\nTHREE\n')
        const file = (await clientFor(a).manifest(null)).items[0]!
        expect(await clientFor(a).versions(file.file_id)).toHaveLength(4)
      }),
    SETUP_MS
  )

  for (const prefer of ['mine', 'theirs', undefined] as const) {
    for (const cut of ['join-marker', 'commit-after']) {
      it(
        `join ${prefer ?? 'merge'} at ${cut} retains its preference after SIGKILL`,
        () =>
          withFolderWork(async () => {
            const { a, b } = await vaultPair(server, `join-${prefer}-${cut}`)
            await write(a, 'note.md', 'remote\n')
            await syncOnce(a)
            await write(b, 'note.md', 'local\n')
            writeConfig(b, { ...config(b), ...(prefer ? { joinPrefer: prefer } : {}) })
            await killAt(b, cut)
            await converge(a, b)
            expect(await read(b, 'note.md')).toBe(
              prefer === 'mine' ? 'local\n' : prefer === 'theirs' ? 'remote\n' : 'remote\nlocal\n'
            )
          }),
        SETUP_MS
      )
    }
  }

  for (const decision of ['confirm', 'restore']) {
    it(
      `held-delete ${decision} survives SIGKILL after clearing the decision`,
      () =>
        withFolderWork(async () => {
          const { a, b } = await vaultPair(server, `held-${decision}`)
          for (let i = 0; i < 40; i++) await write(a, `n${i}.md`, `note ${i}`)
          await converge(a, b)
          for (let i = 0; i < 20; i++) await unlink(join(b, `n${i}.md`))
          await syncOnce(b)
          const state = SqliteStateStore.open(join(b, '.abele-sync/state.db'))
          try {
            const held = JSON.parse(state.getMeta('held-deletes')!) as Array<{ fileId: string }>
            expect(held).toHaveLength(20)
            state.setMeta(
              'delete-decision',
              JSON.stringify({
                kind: decision,
                fileIds: held.map((x) => x.fileId),
                at: new Date().toISOString(),
              })
            )
          } finally {
            state.close()
          }
          await killAt(b, 'held-decision')
          await converge(a, b)
          expect((await clientFor(a).manifest(null)).items).toHaveLength(
            decision === 'restore' ? 40 : 20
          )
        }),
      SETUP_MS
    )
  }

  for (const cut of [
    'scan',
    'upload',
    'commit-before',
    'commit-after',
    'record',
    'pull-write',
    'pull-ledger',
    'pull-cursor',
  ]) {
    // BUG: U2 — pull-write before ledger produces a redundant third history version.
    it(
      `${cut}: restart converges, keeps identity and does not duplicate history`,
      () =>
        withFolderWork(async () => {
          const { a, b } = await vaultPair(server, `adversarial-${cut}`)
          await write(a, 'note.md', 'baseline\n')
          await converge(a, b)
          const client = clientFor(a)
          const initial = (await client.manifest(null)).items[0]!
          const pull = cut.startsWith('pull-')
          await write(pull ? a : b, 'note.md', 'edited before SIGKILL\n')
          if (pull) await syncOnce(a)
          await killAt(b, cut)
          await converge(a, b)
          expect(await read(a, 'note.md')).toBe('edited before SIGKILL\n')
          const heads = (await client.manifest(null)).items
          expect(heads).toHaveLength(1)
          expect(heads[0]!.file_id).toBe(initial.file_id)
          expect(await client.versions(initial.file_id)).toHaveLength(2)
          const seq = (await client.state()).head_seq
          await converge(a, b)
          expect((await client.state()).head_seq).toBe(seq)
        }),
      SETUP_MS
    )
  }
})
