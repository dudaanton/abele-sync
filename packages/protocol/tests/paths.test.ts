import { describe, it, expect } from 'vitest'
import {
  normalisePath,
  validatePath,
  caseKey,
  splitPath,
  nextFreeName,
  kindOf,
} from '../src/paths.js'

describe('normalisePath', () => {
  it('normalises to NFC and forward slashes', () => {
    const nfd = 'Café/note.md'
    expect(normalisePath(nfd)).toBe('Café/note.md')
    expect(normalisePath('a\\b\\c.md')).toBe('a/b/c.md')
  })
  it('strips leading ./ and / and trailing /', () => {
    expect(normalisePath('./a/b/')).toBe('a/b')
    expect(normalisePath('/a/b')).toBe('a/b')
  })
})

describe('validatePath', () => {
  const bad = [
    '',
    'a:b.md',
    'a*b',
    'a?b',
    'a"b',
    'a<b',
    'a>b',
    'a|b',
    'a/../b',
    '../a',
    'a//b',
    ' a.md',
    'a.md ',
    'a./b',
    '.private/file.md',
    'folder/.secret.md',
    'a/.',
    'CON',
    'x/prn.txt',
    'com1/a.md',
    'a\u0000b',
    'a\tb',
    'x'.repeat(256) + '.md',
  ]
  for (const p of bad) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      expect(() => validatePath(p)).toThrowError(expect.objectContaining({ code: 'invalid_path' }))
    })
  }
  const good = [
    'a.md',
    'Folder/Sub/note.md',
    '.obsidian/app.json',
    '.trash/x.md',
    'Café/é.png',
    'a b/c d.md',
    'conx.md',
    'file.tar.gz',
  ]
  for (const p of good) {
    it(`accepts ${JSON.stringify(p)}`, () => {
      expect(() => validatePath(p)).not.toThrow()
    })
  }
  it('rejects paths over 1024 bytes', () => {
    const p = Array.from({ length: 10 }, () => 'x'.repeat(120)).join('/') + '.md'
    expect(() => validatePath(p)).toThrowError(expect.objectContaining({ code: 'invalid_path' }))
  })
})

describe('caseKey', () => {
  it('folds case and NFC', () => {
    expect(caseKey('Café/Note.MD')).toBe('café/note.md')
    expect(caseKey('Café/x')).toBe('café/x')
  })
})

describe('splitPath', () => {
  it('splits folder, name, stem, ext', () => {
    expect(splitPath('a/b/c.tar.gz')).toEqual({
      folder: 'a/b',
      name: 'c.tar.gz',
      stem: 'c.tar',
      ext: '.gz',
    })
    expect(splitPath('c.md')).toEqual({ folder: '', name: 'c.md', stem: 'c', ext: '.md' })
    expect(splitPath('a/.hidden')).toEqual({
      folder: 'a',
      name: '.hidden',
      stem: '.hidden',
      ext: '',
    })
  })
})

describe('nextFreeName', () => {
  it('returns the path itself when free', () => {
    expect(nextFreeName('img.png', () => false)).toBe('img.png')
  })
  it('appends " 1", " 2" like Obsidian, skipping taken ones, case-insensitively', () => {
    const taken = new Set(['img.png', 'img 1.png', 'img 2.png'].map(caseKey))
    expect(nextFreeName('IMG.png', (k) => taken.has(k))).toBe('IMG 3.png')
  })
  it('keeps the folder', () => {
    const taken = new Set(['a/b/n.md'])
    expect(nextFreeName('a/b/n.md', (k) => taken.has(k))).toBe('a/b/n 1.md')
  })
})

describe('kindOf', () => {
  it('classifies by extension and folder', () => {
    expect(kindOf('a/b.md', 'Scripts')).toBe('note')
    expect(kindOf('a/b.MD', 'Scripts')).toBe('note')
    expect(kindOf('a/b.canvas', 'Scripts')).toBe('canvas')
    expect(kindOf('.obsidian/app.json', 'Scripts')).toBe('settings')
    expect(kindOf('.obsidian/snippets/x.css', 'Scripts')).toBe('settings')
    expect(kindOf('Scripts/x.js', 'Scripts')).toBe('script')
    expect(kindOf('Scripts/deep/x.js', 'Scripts')).toBe('script')
    expect(kindOf('Other/x.js', 'Scripts')).toBe('attachment')
    expect(kindOf('Scripts/readme.md', 'Scripts')).toBe('note')
    expect(kindOf('a/b.png', 'Scripts')).toBe('attachment')
    expect(kindOf('chats/x.abchat', 'Scripts')).toBe('attachment')
  })
})

describe('normalisePath bounds', () => {
  it('strips a long run of slashes without going quadratic', () => {
    const raw = 'a' + '/'.repeat(3000) + 'b'
    const started = performance.now()
    expect(normalisePath(raw)).toBe(raw)
    expect(performance.now() - started).toBeLessThan(100)
  })
  it('refuses raw input over 4096 bytes without echoing it', () => {
    expect(() => normalisePath('x'.repeat(5000))).toThrowError(
      expect.objectContaining({
        code: 'invalid_path',
        details: { path: '<omitted>', reason: 'too long' },
      })
    )
  })
})

describe('validatePath NFC', () => {
  it('rejects a decomposed path', () => {
    const nfd = 'Café.md'.normalize('NFD')
    expect(() => validatePath(nfd)).toThrowError(
      expect.objectContaining({ code: 'invalid_path', details: { path: nfd, reason: 'not nfc' } })
    )
  })
  it('accepts the composed form', () => {
    expect(() => validatePath('Café.md'.normalize('NFC'))).not.toThrow()
  })
})

describe('validatePath boundaries', () => {
  it('rejects the DEL control character', () => {
    const del = `a${String.fromCharCode(0x7f)}b`
    expect(() => validatePath(del)).toThrowError(
      expect.objectContaining({ details: { path: del, reason: 'forbidden character' } })
    )
  })
  it('reports path and reason in details', () => {
    expect(() => validatePath('a:b.md')).toThrowError(
      expect.objectContaining({ details: { path: 'a:b.md', reason: 'forbidden character' } })
    )
  })
  it('accepts a 255-byte segment and rejects 256', () => {
    expect(() => validatePath('x'.repeat(255))).not.toThrow()
    expect(() => validatePath('x'.repeat(256))).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'segment too long' }) })
    )
  })
  it('accepts a 1024-byte path and rejects 1025', () => {
    const path = (last: number) =>
      [...Array.from({ length: 4 }, () => 'x'.repeat(204)), 'x'.repeat(last)].join('/')
    const ok = path(204)
    expect(Buffer.byteLength(ok, 'utf8')).toBe(1024)
    expect(() => validatePath(ok)).not.toThrow()
    const tooLong = path(205)
    expect(Buffer.byteLength(tooLong, 'utf8')).toBe(1025)
    expect(() => validatePath(tooLong)).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ reason: 'too long' }) })
    )
  })
})

describe('nextFreeName without an extension', () => {
  it('appends to a bare name', () => {
    const taken = new Set(['notes/readme'])
    expect(nextFreeName('notes/README', (k) => taken.has(k))).toBe('notes/README 1')
  })
  it('does not generate a path forbidden by the wire rules', () => {
    const taken = new Set(['.env'])
    expect(() => nextFreeName('.env', (k) => taken.has(k))).toThrowError(
      expect.objectContaining({ code: 'invalid_path' })
    )
  })
  it('gives up when every candidate is taken', () => {
    expect(() => nextFreeName('img.png', () => true)).toThrowError(
      expect.objectContaining({ code: 'path_taken', details: { path: 'img.png' } })
    )
  })
})

describe('kindOf scripts folder', () => {
  it('matches the scripts folder case-insensitively', () => {
    expect(kindOf('scripts/x.js', 'Scripts')).toBe('script')
  })
  it('tolerates a trailing slash on the folder', () => {
    expect(kindOf('Scripts/x.js', 'Scripts/')).toBe('script')
  })
  it('treats an empty scripts folder as no scripts folder', () => {
    expect(kindOf('x.js', '')).toBe('attachment')
  })
})
