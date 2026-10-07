import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adversarial, type Adversarial } from '../helpers/adversarial.js'
import { converge } from '../helpers/device.js'
import { shaOf } from '../helpers/seed.js'

let t: Adversarial
beforeEach(async () => {
  t = await adversarial()
})
afterEach(async () => {
  await t.close()
})
const orders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
]

describe('Adversarial: three offline editors, every arrival order', () => {
  for (const kind of ['same-line', 'different-lines', 'groups', 'delimiters', 'invalid-utf8']) {
    for (const order of orders) {
      it(`${kind}, arrival ${order.join('')}: convergence and recoverable originals`, async () => {
        const ds = await Promise.all(['a', 'b', 'c'].map((name) => t.device(name)))
        const base =
          kind === 'groups' || kind === 'delimiters'
            ? '---\ngroups:\n  - base\n---\none\ntwo\nthree\n'
            : 'one\ntwo\nthree\n'
        await ds[0]!.write('note.md', base)
        await converge(...ds)
        const originals: Array<string | Uint8Array> = []
        for (let i = 0; i < 3; i++) {
          let text: string | Uint8Array
          if (kind === 'same-line') text = `one\nwriter-${i}\nthree\n`
          else if (kind === 'different-lines') {
            const lines = ['one', 'two', 'three']
            lines[i] = `writer-${i}`
            text = `${lines.join('\n')}\n`
          } else if (kind === 'groups') text = base.replace('  - base', `  - group-${i}`)
          else if (kind === 'delimiters')
            text =
              i === 0
                ? base.replace('---\none', '---\n---\none')
                : base.replace('  - base', `  - [group-${i}]`)
          else text = new Uint8Array([111, 110, 101, 10, 255, 128 + i, 10])
          originals.push(text)
          await ds[i]!.write('note.md', text)
        }
        for (const i of order) await ds[i]!.sync()
        await converge(...ds)
        // A conflict copy is acceptable; silent loss of any input bytes is not.
        const shas = new Set<string>()
        const manifest = (await ds[0]!.client.manifest(null)).items
        for (const head of manifest) {
          for (const version of await ds[0]!.client.versions(head.file_id)) {
            if (version.sha) {
              shas.add(version.sha)
              expect(
                await shaOf(await ds[0]!.client.versionBytes(head.file_id, version.version_id))
              ).toBe(version.sha)
            }
          }
        }
        for (const original of originals) expect(shas.has(await shaOf(original))).toBe(true)
        if (kind === 'same-line' || kind === 'different-lines') {
          for (let i = 0; i < 3; i++) expect(await ds[0]!.text('note.md')).toContain(`writer-${i}`)
        }
        const seq = (await ds[0]!.client.state()).head_seq
        await converge(...ds)
        expect((await ds[0]!.client.state()).head_seq).toBe(seq)
      })
    }
  }

  for (const budget of ['matching-pairs', 'total-lines'] as const) {
    it(`${budget}: exceeding line work keeps the exact edits in separate files`, async () => {
      const ds = await Promise.all(['a', 'b', 'c'].map((name) => t.device(name)))
      const base =
        budget === 'matching-pairs'
          ? 'shared\n'.repeat(800)
          : Array.from({ length: 34_000 }, (_, i) => `line ${i}\n`).join('')
      const head = `HEAD\n${base}`
      const incoming = `${base}INCOMING\n`
      await ds[0]!.write('note.md', base)
      await converge(...ds)
      await ds[0]!.write('note.md', head)
      await ds[1]!.write('note.md', incoming)
      await ds[0]!.sync()
      const report = await ds[1]!.sync()
      expect(report.push.conflicts).toBe(1)
      await converge(...ds)
      for (const d of ds) {
        expect(d.paths()).toHaveLength(2)
        expect(await d.text('note.md')).toBe(head)
        const copy = d.paths().find((path) => path !== 'note.md')!
        expect(copy).toContain('Conflicted copy')
        expect(await d.text(copy)).toBe(incoming)
      }
      const entry = (await ds[0]!.state.get('note.md'))!
      expect(await ds[0]!.client.versions(entry.fileId)).toHaveLength(2)
      const seq = (await ds[0]!.client.state()).head_seq
      await converge(...ds)
      expect((await ds[0]!.client.state()).head_seq).toBe(seq)
    })
  }

  it('attachment and settings ties keep the first head; clock-skew winner preserves losing history', async () => {
    const ds = await Promise.all(['a', 'b', 'c'].map((name) => t.device(name)))
    for (const path of ['picture.bin', '.obsidian/app.json']) await ds[0]!.write(path, 'base', 1)
    await converge(...ds)
    for (let i = 0; i < 3; i++)
      for (const path of ['picture.bin', '.obsidian/app.json']) {
        await ds[i]!.write(path, `writer-${i}`, i === 2 ? 4_102_444_800_000 : 100)
      }
    for (const d of ds) await d.sync()
    await converge(...ds)
    for (const path of ['picture.bin', '.obsidian/app.json']) {
      expect(await ds[0]!.text(path)).toBe('writer-2')
      const file = (await ds[0]!.state.get(path))!
      const hashes = (await ds[0]!.client.versions(file.fileId)).map((v) => v.sha)
      for (let i = 0; i < 3; i++) expect(hashes).toContain(await shaOf(`writer-${i}`))
    }
  })

  it('2101 files cross commit and manifest pages on three devices without duplicate versions', async () => {
    const ds = await Promise.all(['a', 'b', 'c'].map((name) => t.device(name)))
    for (let i = 0; i < 2101; i++) await ds[0]!.write(`notes/${i}.md`, `synthetic ${i}\n`)
    await converge(...ds)
    expect(ds[0]!.stats.commits).toBe(3)
    for (const d of ds) expect(d.paths()).toHaveLength(2101)
    expect((await ds[0]!.client.state()).head_seq).toBe(2101)
  }, 90000)
})
