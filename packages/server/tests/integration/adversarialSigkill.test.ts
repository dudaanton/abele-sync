import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const childFile = fileURLToPath(new URL('../helpers/adversarialCrashChild.mjs', import.meta.url))

async function run(dir: string, mode: string, phase: 'cut' | 'recover'): Promise<any> {
  const child = fork(childFile, [dir, mode, phase], { silent: true, execArgv: [] })
  let output = ''
  child.stderr?.on('data', (chunk) => {
    output += String(chunk)
  })
  const exited = once(child, 'exit')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const message: any = await Promise.race([
      once(child, 'message').then(([message]) => message),
      exited.then(([code, signal]) => {
        throw new Error(`child exited ${code}/${signal}: ${output}`)
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('barrier timeout')), 10000)
      }),
    ])
    if (message.error) throw new Error(message.error)
    if (phase === 'cut') {
      expect(message).toEqual({ barrier: mode })
      child.kill('SIGKILL')
      expect(await exited).toEqual([null, 'SIGKILL'])
    } else {
      expect((await exited)[0], output).toBe(0)
    }
    return message.result
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  }
}

describe('Adversarial: real server-worker SIGKILL with a persistent SQLite database', () => {
  for (const mode of [
    'gc-referenced-before-delete',
    'gc-referenced-after-delete',
    'gc-unclaimed-before-delete',
    'gc-unclaimed-after-delete',
  ]) {
    // BUG: B4 — durable refs=-1 is never reclaimed by startup/the next sweep.
    it(`B4 ${mode}: identical content can be committed after restart`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'abele-adversarial-server-kill-'))
      try {
        await run(dir, mode, 'cut')
        const result = await run(dir, mode, 'recover')
        expect(result, JSON.stringify(result)).toMatchObject({
          committed: true,
          refs: 1,
          present: true,
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
  // completing_at survives process death; a fresh upload handler must finish it.
  it('B5 completes an upload after SIGKILL immediately after the completion claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'abele-adversarial-upload-kill-'))
    try {
      await run(dir, 'upload-completing', 'cut')
      const result = await run(dir, 'upload-completing', 'recover')
      expect(result, JSON.stringify(result)).toMatchObject({ completed: true })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
