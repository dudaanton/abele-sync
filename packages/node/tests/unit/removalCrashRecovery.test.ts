import { mkdtemp, mkdir, writeFile, readFile, link, rename, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { sha256, retentionSnapshot } from '@abele/sync-core'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { retentionHandedOver } from '../../src/removalSafety.js'

// On-disk crash model: publication, nested capture, destination link, outer
// receipt retirement, and legacy adoption can each be interrupted independently.
it.each(
  ['conditional', 'conditional-complete'].flatMap((location) =>
    ['a-outer', 'z-outer'].flatMap((outer) =>
      ['captured', 'linked', 'outer-moved', 'mixed-legacy'].map((cut) => ({ outer, cut, location }))
    )
  )
)(
  'recovers removal crash cut $cut with $location/$outer first/last',
  async ({ outer, cut, location }) => {
    const root = await mkdtemp(join(tmpdir(), 'removal-crash-'))
    try {
      const fs = new NodeFileSystem(root)
      const folder = `.abele-sync/${location}/${outer}`
      await fs.writeAtomic(`${folder}/victim`, new Uint8Array([1]), 1)
      const expected = {
        ...(await fs.stat(`${folder}/victim`))!,
        sha: await sha256(new Uint8Array([1])),
      }
      await fs.writeAtomic(`${folder}/data`, new Uint8Array([2]), 2)
      await link(join(root, folder, 'data'), join(root, 'a.md'))
      await writeFile(
        join(root, folder, 'intent.json'),
        JSON.stringify({
          path: 'a.md',
          effect: 'write',
          receipt: outer,
          expected,
        })
      )
      if (cut !== 'mixed-legacy') {
        const inner = '.abele-sync/conditional/m-inner'
        const victim = '.abele-sync/retained-removals/retained/victim'
        await mkdir(join(root, inner), { recursive: true })
        await mkdir(join(root, '.abele-sync/retained-removals/retained'), { recursive: true })
        await writeFile(
          join(root, inner, 'intent.json'),
          JSON.stringify({
            path: `${folder}/victim`,
            effect: 'move',
            to: victim,
            expected,
          })
        )
        await writeFile(
          join(root, '.abele-sync/retained-removals/summary.json'),
          JSON.stringify([
            {
              id: 'retained',
              path: 'a.md',
              victim,
              expected,
              capturedAt: Date.now(),
              phase: 'prepared',
              publication: { kind: 'installation', id: outer },
            },
          ])
        )
        await rename(join(root, folder, 'victim'), join(root, inner, 'victim'))
        if (cut === 'linked') await link(join(root, inner, 'victim'), join(root, victim))
        if (cut === 'outer-moved') {
          await mkdir(join(root, '.abele-sync/installations'), { recursive: true })
          await rename(join(root, folder), join(root, '.abele-sync/installations', outer))
        }
      } else {
        await mkdir(join(root, '.abele-sync/retained-removals/legacy'), { recursive: true })
        await writeFile(
          join(root, '.abele-sync/retained-removals/legacy/a.md'),
          new Uint8Array([3])
        )
      }
      for (let replay = 0; replay < 3; replay++) {
        await new NodeFileSystem(root).recoverConditionalFiles()
        expect(await fs.read('a.md')).toEqual(new Uint8Array([2]))
      }
      const rows = await retentionSnapshot(fs)
      const retained = await Promise.all(rows.map((row) => fs.read(row.victim)))
      const publicCopies = await Promise.all(
        (await readdir(root))
          .filter((name) => name.includes('.sync-conflict-'))
          .map((name) => fs.read(name))
      )
      expect([...retained, ...publicCopies]).toContainEqual(new Uint8Array([1]))
      if (cut === 'captured' || cut === 'linked') {
        expect(retained).toEqual([new Uint8Array([1])])
        expect(publicCopies).toEqual([])
      }
      if (cut === 'outer-moved') {
        expect(await fs.read('a.md.sync-conflict-m-inner')).toEqual(new Uint8Array([1]))
      }
      if (cut === 'mixed-legacy') {
        expect(await fs.read('a.md.sync-conflict-legacy')).toEqual(new Uint8Array([3]))
      }
      await fs.discardInstallation(outer)
      await fs.recoverConditionalFiles()
      expect(retentionHandedOver(join(root, '.abele-sync/retained-removals'))).toBe(true)
      expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('exposes a failed restore when its original parent disappeared, without a retry loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removal-restore-'))
  try {
    const folder = join(root, '.abele-sync/conditional/orphan')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'intent.json'),
      JSON.stringify({ path: 'missing/a.md', effect: 'move' })
    )
    await writeFile(join(folder, 'victim'), 'unique')
    const fs = new NodeFileSystem(root)
    await fs.recoverConditionalFiles()
    await fs.recoverConditionalFiles()
    expect(await readFile(join(root, 'Recovered.sync-conflict-orphan'), 'utf8')).toBe('unique')
    expect(await readdir(join(root, '.abele-sync/conditional'))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('repairs an interrupted legacy completion marker without skipping adoption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'removal-marker-'))
  try {
    const folder = join(root, '.abele-sync/retained-removals')
    await mkdir(join(folder, 'legacy'), { recursive: true })
    await writeFile(join(folder, 'legacy/a.md'), 'unique')
    await writeFile(join(folder, 'summary.json'), '[]')
    await writeFile(join(folder, 'legacy-migrated'), '')
    const fs = new NodeFileSystem(root)
    await fs.recoverConditionalFiles()
    await fs.recoverConditionalFiles()
    expect(await readFile(join(root, 'a.md'), 'utf8')).toBe('unique')
    expect(await readFile(join(folder, 'legacy-migrated'), 'utf8')).toBe('1')
    expect(retentionHandedOver(folder)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
