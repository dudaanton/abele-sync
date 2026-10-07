import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const TSC = fileURLToPath(new URL('../../../../node_modules/typescript/bin/tsc', import.meta.url))

/**
 * Child-process fixtures import production JS, outside Vitest's source aliases. Build before
 * workers start, always forcing emission: a surviving tsbuildinfo must not hide a missing or
 * stale dist. Build the CLI/core too because a root run also starts daemon child fixtures;
 * their server-exists shortcut otherwise skips those packages after this setup built server.
 */
export default function setup(): void {
  const built = spawnSync(
    process.execPath,
    [TSC, '-b', '--force', 'packages/protocol', 'packages/server', 'packages/core', 'packages/cli'],
    { cwd: ROOT, encoding: 'utf8' }
  )
  if (built.error !== undefined || built.status !== 0) {
    throw new Error(
      `child fixture build failed: ${built.error?.message ?? built.stderr + built.stdout}`
    )
  }
}
