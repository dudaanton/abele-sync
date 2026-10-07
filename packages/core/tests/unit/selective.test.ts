import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SELECTIVE,
  FILE_TYPE_EXTENSIONS,
  isExcluded,
  isHidden,
  selectiveDefaults,
  settingsCategory,
  type SelectiveSettings,
} from '../../src/index.js'

const SCRIPTS = 'Scripts'

/** A fresh, mutable set of defaults with a few switches thrown. */
function withSettings(patch: Partial<SelectiveSettings>): SelectiveSettings {
  return { ...selectiveDefaults(), ...patch }
}

/** Every file type off, so only the never-excluded kinds survive. */
const NOTHING: SelectiveSettings = withSettings({
  images: false,
  audio: false,
  video: false,
  pdf: false,
  other: false,
})

function excluded(path: string, s: SelectiveSettings = DEFAULT_SELECTIVE, size = 10): boolean {
  return isExcluded(path, size, s, SCRIPTS)
}

/** Defaults with one file type switched off. */
function typeOff(type: 'images' | 'audio' | 'video' | 'pdf'): SelectiveSettings {
  const s = withSettings({})
  s[type] = false
  return s
}

describe('DEFAULT_SELECTIVE', () => {
  it('has every file type on, no exclusions and no cap', () => {
    expect(DEFAULT_SELECTIVE).toEqual({
      images: true,
      audio: true,
      video: true,
      pdf: true,
      other: true,
      excludedFolders: [],
      maxFileBytes: null,
      settings: {
        main: true,
        appearance: true,
        hotkeys: true,
        corePlugins: true,
        communityPlugins: true,
        pluginSettings: true,
      },
    })
  })

  it('is frozen through and through', () => {
    expect(Object.isFrozen(DEFAULT_SELECTIVE)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SELECTIVE.settings)).toBe(true)
    expect(Object.isFrozen(DEFAULT_SELECTIVE.excludedFolders)).toBe(true)
  })

  it('hands out a fresh, mutable copy through selectiveDefaults', () => {
    const a = selectiveDefaults()
    const b = selectiveDefaults()
    expect(a).toEqual(DEFAULT_SELECTIVE)
    expect(a.settings).not.toBe(b.settings)
    expect(a.excludedFolders).not.toBe(b.excludedFolders)
    a.settings.main = false
    a.excludedFolders.push('Archive')
    expect(b.settings.main).toBe(true)
    expect(DEFAULT_SELECTIVE.settings.main).toBe(true)
    expect(DEFAULT_SELECTIVE.excludedFolders).toEqual([])
  })
})

describe('FILE_TYPE_EXTENSIONS', () => {
  it("carries Obsidian's lists", () => {
    expect(FILE_TYPE_EXTENSIONS.images).toEqual([
      'png',
      'jpg',
      'jpeg',
      'gif',
      'bmp',
      'svg',
      'webp',
      'avif',
    ])
    expect(FILE_TYPE_EXTENSIONS.audio).toEqual([
      'mp3',
      'wav',
      'm4a',
      '3gp',
      'flac',
      'ogg',
      'oga',
      'opus',
    ])
    expect(FILE_TYPE_EXTENSIONS.video).toEqual(['mp4', 'webm', 'ogv', 'mov', 'mkv'])
    expect(FILE_TYPE_EXTENSIONS.pdf).toEqual(['pdf'])
  })

  it('lists no extension under two types', () => {
    const all = Object.values(FILE_TYPE_EXTENSIONS).flat()
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('isExcluded by file type', () => {
  for (const type of ['images', 'audio', 'video', 'pdf'] as const) {
    it(`keeps every ${type} extension when ${type} is on and drops it when off`, () => {
      const off = typeOff(type)
      for (const ext of FILE_TYPE_EXTENSIONS[type]) {
        expect(excluded(`Files/clip.${ext}`)).toBe(false)
        expect(excluded(`Files/clip.${ext}`, off)).toBe(true)
      }
    })

    it(`leaves the other types alone when ${type} is off`, () => {
      const off = typeOff(type)
      const others = (['images', 'audio', 'video', 'pdf'] as const).filter((t) => t !== type)
      for (const other of others) {
        expect(excluded(`Files/clip.${FILE_TYPE_EXTENSIONS[other][0]}`, off)).toBe(false)
      }
    })
  }

  it('matches the extension whatever its case', () => {
    expect(excluded('Files/PHOTO.PNG', withSettings({ images: false }))).toBe(true)
    expect(excluded('Files/Clip.MoV', withSettings({ video: false }))).toBe(true)
  })

  it('never excludes a note or a canvas by type', () => {
    expect(excluded('notes/a.md', NOTHING)).toBe(false)
    expect(excluded('boards/b.canvas', NOTHING)).toBe(false)
    expect(excluded('A.MD', NOTHING)).toBe(false)
  })

  it('treats a script as other', () => {
    expect(excluded(`${SCRIPTS}/tool.js`, NOTHING)).toBe(true)
    expect(excluded(`${SCRIPTS}/tool.js`, withSettings({ other: true }))).toBe(false)
    expect(excluded(`${SCRIPTS}/tool.js`, withSettings({ other: false }))).toBe(true)
  })

  it('treats an attachment of no listed type as other', () => {
    const noOther = withSettings({ other: false })
    for (const path of ['Files/data.bin', 'Files/notes.txt', 'Files/README', 'Files/.keep']) {
      expect(excluded(path)).toBe(false)
      expect(excluded(path, noOther)).toBe(true)
    }
  })

  it('keeps a listed type when only other is off', () => {
    expect(excluded('Files/a.png', withSettings({ other: false }))).toBe(false)
  })
})

describe('isExcluded by folder', () => {
  const s = withSettings({ excludedFolders: ['Archive'] })

  it('excludes files directly in the folder and below it', () => {
    expect(excluded('Archive/x.md', s)).toBe(true)
    expect(excluded('Archive/sub/y.png', s)).toBe(true)
  })

  it('matches whole folder names only', () => {
    expect(excluded('Archives/x.md', s)).toBe(false)
    expect(excluded('Archived.md', s)).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(excluded('archive/x.md', s)).toBe(false)
    expect(excluded('ARCHIVE/x.md', s)).toBe(false)
  })

  it('does not exclude a file that shares the folder name', () => {
    expect(excluded('Archive', s)).toBe(false)
  })

  it('matches a nested folder path', () => {
    const nested = withSettings({ excludedFolders: ['a/b'] })
    expect(excluded('a/b/c.md', nested)).toBe(true)
    expect(excluded('a/bb/c.md', nested)).toBe(false)
    expect(excluded('x/a/b/c.md', nested)).toBe(false)
  })

  it('tolerates a trailing slash and ignores an empty entry', () => {
    expect(excluded('Archive/x.md', withSettings({ excludedFolders: ['Archive/'] }))).toBe(true)
    expect(excluded('Archive/x.md', withSettings({ excludedFolders: [''] }))).toBe(false)
  })

  it('excludes a note, which no type switch can', () => {
    expect(excluded('Archive/x.md', s)).toBe(true)
  })
})

describe('isExcluded by size', () => {
  const s = withSettings({ maxFileBytes: 1000 })

  it('keeps a file at the cap and drops one over it', () => {
    expect(isExcluded('Files/a.png', 999, s, SCRIPTS)).toBe(false)
    expect(isExcluded('Files/a.png', 1000, s, SCRIPTS)).toBe(false)
    expect(isExcluded('Files/a.png', 1001, s, SCRIPTS)).toBe(true)
  })

  it('caps notes too', () => {
    expect(isExcluded('notes/a.md', 1001, s, SCRIPTS)).toBe(true)
    expect(isExcluded('notes/a.md', 1000, s, SCRIPTS)).toBe(false)
  })

  it('caps a settings file too', () => {
    expect(isExcluded('.obsidian/app.json', 1001, s, SCRIPTS)).toBe(true)
    expect(isExcluded('.obsidian/app.json', 1000, s, SCRIPTS)).toBe(false)
  })

  it('caps nothing when the cap is null', () => {
    expect(isExcluded('Files/a.png', 10 ** 12, DEFAULT_SELECTIVE, SCRIPTS)).toBe(false)
  })
})

describe("isExcluded for the engine's own files", () => {
  it('never syncs the state folder or the ignore file', () => {
    expect(excluded('.abele-sync/state.db')).toBe(true)
    expect(excluded('.abele-sync/tmp/abc')).toBe(true)
    expect(excluded('.abele-sync-ignore')).toBe(true)
    expect(excluded('.abele-sync')).toBe(true)
  })

  it('leaves a lookalike path alone', () => {
    expect(excluded('notes/.abele-sync/x.md')).toBe(false)
    expect(excluded('.abele-syncnotes/a.md')).toBe(false)
    expect(excluded('.abele-sync-ignore.md')).toBe(false)
  })

  it('matches whatever case the disk hands back', () => {
    expect(excluded('.ABELE-SYNC/state.db')).toBe(true)
    expect(excluded('.Abele-Sync')).toBe(true)
    expect(excluded('.ABELE-SYNC-IGNORE')).toBe(true)
  })
})

describe('settingsCategory', () => {
  it('is null outside .obsidian', () => {
    expect(settingsCategory('notes/a.md')).toBeNull()
    expect(settingsCategory('app.json')).toBeNull()
    expect(settingsCategory('.obsidian')).toBeNull()
    expect(settingsCategory('sub/.obsidian/app.json')).toBeNull()
  })

  it('maps the main settings file', () => {
    expect(settingsCategory('.obsidian/app.json')).toBe('main')
  })

  it('maps appearance, themes and snippets', () => {
    expect(settingsCategory('.obsidian/appearance.json')).toBe('appearance')
    expect(settingsCategory('.obsidian/themes/x/theme.css')).toBe('appearance')
    expect(settingsCategory('.obsidian/themes/x/manifest.json')).toBe('appearance')
    expect(settingsCategory('.obsidian/snippets/a.css')).toBe('appearance')
  })

  it('maps hotkeys', () => {
    expect(settingsCategory('.obsidian/hotkeys.json')).toBe('hotkeys')
  })

  it('maps the core plugin lists', () => {
    expect(settingsCategory('.obsidian/core-plugins.json')).toBe('corePlugins')
    expect(settingsCategory('.obsidian/core-plugins-migration.json')).toBe('corePlugins')
  })

  it('maps the community plugin list and each plugin file', () => {
    expect(settingsCategory('.obsidian/community-plugins.json')).toBe('communityPlugins')
    expect(settingsCategory('.obsidian/plugins/foo/main.js')).toBe('communityPlugins')
    expect(settingsCategory('.obsidian/plugins/foo/manifest.json')).toBe('communityPlugins')
    expect(settingsCategory('.obsidian/plugins/foo/styles.css')).toBe('communityPlugins')
  })

  it('maps a plugin data file on its own', () => {
    expect(settingsCategory('.obsidian/plugins/foo/data.json')).toBe('pluginSettings')
  })

  it('never syncs the workspace or the graph', () => {
    expect(settingsCategory('.obsidian/workspace.json')).toBe('never')
    expect(settingsCategory('.obsidian/workspace-mobile.json')).toBe('never')
    expect(settingsCategory('.obsidian/graph.json')).toBe('never')
    expect(settingsCategory('.obsidian/workspace/left.json')).toBe('never')
  })

  it('answers a file named after an Object property with never', () => {
    expect(settingsCategory('.obsidian/constructor')).toBe('never')
    expect(settingsCategory('.obsidian/__proto__')).toBe('never')
    expect(settingsCategory('.obsidian/toString')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/foo/toString')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/foo/constructor')).toBe('never')
  })

  it('takes any core-plugins list, not just the two Obsidian ships', () => {
    expect(settingsCategory('.obsidian/core-plugins-foo.json')).toBe('corePlugins')
    expect(settingsCategory('.obsidian/core-plugins.json.bak')).toBe('never')
    expect(settingsCategory('.obsidian/core-plugins/x.json')).toBe('never')
  })

  it('takes a plugin file at exactly one level under the plugin folder', () => {
    expect(settingsCategory('.obsidian/plugins/x/sub/data.json')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/x/sub/main.js')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/data.json')).toBe('never')
  })

  it('never syncs anything else under .obsidian', () => {
    expect(settingsCategory('.obsidian/whatever.json')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/foo/cache/db.bin')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/foo/extra.json')).toBe('never')
    expect(settingsCategory('.obsidian/plugins/main.js')).toBe('never')
    expect(settingsCategory('.obsidian/App.json')).toBe('never')
  })
})

describe('isExcluded under .obsidian', () => {
  const cases: [string, keyof SelectiveSettings['settings']][] = [
    ['.obsidian/app.json', 'main'],
    ['.obsidian/appearance.json', 'appearance'],
    ['.obsidian/themes/x/theme.css', 'appearance'],
    ['.obsidian/snippets/a.css', 'appearance'],
    ['.obsidian/hotkeys.json', 'hotkeys'],
    ['.obsidian/core-plugins.json', 'corePlugins'],
    ['.obsidian/core-plugins-migration.json', 'corePlugins'],
    ['.obsidian/community-plugins.json', 'communityPlugins'],
    ['.obsidian/plugins/foo/main.js', 'communityPlugins'],
    ['.obsidian/plugins/foo/manifest.json', 'communityPlugins'],
    ['.obsidian/plugins/foo/styles.css', 'communityPlugins'],
    ['.obsidian/plugins/foo/data.json', 'pluginSettings'],
  ]

  for (const [path, category] of cases) {
    it(`syncs ${path} only with ${category} on`, () => {
      expect(excluded(path)).toBe(false)
      const off = withSettings({})
      off.settings[category] = false
      expect(excluded(path, off)).toBe(true)
    })
  }

  it('excludes a never file however the switches stand', () => {
    expect(excluded('.obsidian/workspace.json')).toBe(true)
    expect(excluded('.obsidian/graph.json')).toBe(true)
    expect(excluded('.obsidian/plugins/foo/cache.db')).toBe(true)
  })

  it('ignores the file type switches for settings', () => {
    expect(excluded('.obsidian/snippets/a.css', NOTHING)).toBe(false)
    expect(excluded('.obsidian/plugins/foo/main.js', NOTHING)).toBe(false)
  })
})

describe('isHidden', () => {
  it('names every path with a dot-segment', () => {
    for (const path of [
      '.git/HEAD',
      '.git/objects/ab/cdef',
      '.DS_Store',
      'Sub/.DS_Store',
      '.stfolder',
      '.trash/old.md',
      'notes/.hidden/a.md',
      '.abele-sync/state.db',
      '.Obsidian/app.json',
    ]) {
      expect([path, isHidden(path)]).toEqual([path, true])
    }
  })

  it('leaves the settings folder to the settings switches, and everything visible alone', () => {
    for (const path of [
      '.obsidian/app.json',
      '.obsidian/plugins/x/data.json',
      '.obsidian/workspace.json',
      'notes/a.md',
      'a.b/c.md',
      'notes/file.with.dots.png',
      'x./y.md',
    ]) {
      expect([path, isHidden(path)]).toEqual([path, false])
    }
  })
})
