import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
it('waits for the main TCP listener rather than the temporary init unix socket', async () => {
  await mkdir(join(root, 'data'), { recursive: true })
  const dir = await mkdtemp(join(root, 'data/readiness-'))
  try {
    await writeFile(
      join(dir, 'docker'),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$FIXTURE/commands"
case "$1" in
run) echo synthetic-container;;
port) echo 127.0.0.1:6543;;
exec)
  # Init server's socket is ready, but the first TCP probe is not.
  if [[ "$*" != *"-h 127.0.0.1 -p 5432"* ]]; then exit 0; fi
  if [ ! -f "$FIXTURE/tcp-probed" ]; then touch "$FIXTURE/tcp-probed"; exit 1; fi;;
rm) exit 0;;
esac
`,
      { mode: 0o700 }
    )
    await writeFile(join(dir, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o700 })
    await writeFile(
      join(dir, 'node'),
      '#!/bin/bash\necho "$ABELE_TEST_PG_URL" > "$FIXTURE/started"\n',
      { mode: 0o700 }
    )
    const result = spawnSync('bash', [join(root, 'scripts/test-sql-disposable.sh')], {
      cwd: root,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: dir },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    const commands = await readFile(join(dir, 'commands'), 'utf8')
    expect(commands.split('\n').filter((line) => line.startsWith('exec '))).toHaveLength(2)
    expect(commands).toContain('pg_isready -h 127.0.0.1 -p 5432 -U postgres')
    expect(commands).toContain('rm -f synthetic-container')
    expect(await readFile(join(dir, 'started'), 'utf8')).toContain('@127.0.0.1:6543/postgres')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
