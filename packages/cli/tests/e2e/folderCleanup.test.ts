import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cleanupFolders, folder, withFolderWork } from './helpers/folders.js'

it('waits for a still-running test and its child to exit before removing folders', async () => {
  const dir = await folder()
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.stdin.resume()
    process.stdout.write('ready')
    process.stdin.on('end', () => {
      require('node:fs').mkdirSync(require('node:path').join(process.argv[1], '.abele-sync'))
      require('node:fs').writeFileSync(require('node:path').join(process.argv[1], '.abele-sync', 'last'), 'write')
    })
  `,
      dir,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const exited = once(child, 'exit')
  const task = withFolderWork(async () => {
    expect(await exited).toEqual([0, null])
    expect(existsSync(join(dir, '.abele-sync', 'last'))).toBe(true)
  })
  let removed = false
  let cleanup: Promise<void> | undefined
  try {
    await once(child.stdout!, 'data')
    cleanup = cleanupFolders().then(() => {
      removed = true
    })
    // Allow filesystem cleanup to finish if it incorrectly ignores the pending work.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(removed).toBe(false)
    expect(existsSync(dir)).toBe(true)
  } finally {
    child.stdin!.end()
    await task
    await cleanup
    await cleanupFolders()
  }
  expect(existsSync(dir)).toBe(false)
})
