import { caseKey, kindOf, splitPath } from '@abele/sync-protocol'

/**
 * Selective sync: which of a vault's files this device syncs at all.
 *
 * The scanner and the puller both run every path through `isExcluded`, so a file this
 * device does not want is neither uploaded nor downloaded. Notes and canvases are always
 * synced; attachments answer to their type; anything under `.obsidian/` answers to the
 * settings category it belongs to.
 */
export interface SelectiveSettings {
  images: boolean
  audio: boolean
  video: boolean
  pdf: boolean
  /** Every attachment of no listed type, and every script. */
  other: boolean
  /** Folder paths, exact and case-sensitive, whose contents this device skips. */
  excludedFolders: string[]
  /** Files strictly larger than this are skipped. `null` is no cap. */
  maxFileBytes: number | null
  settings: {
    main: boolean
    appearance: boolean
    hotkeys: boolean
    corePlugins: boolean
    communityPlugins: boolean
    pluginSettings: boolean
  }
}

/** A fresh set of defaults, safe to mutate: everything on, nothing excluded, no cap. */
export function selectiveDefaults(): SelectiveSettings {
  return {
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
  }
}

/**
 * What a fresh device syncs. Deep-frozen, since every caller shares it: build on
 * `selectiveDefaults()` when the settings are to be edited.
 */
export const DEFAULT_SELECTIVE: SelectiveSettings = deepFreeze(selectiveDefaults())

/** Freezes the settings object and the two things it holds by reference. */
function deepFreeze(s: SelectiveSettings): SelectiveSettings {
  Object.freeze(s.excludedFolders)
  Object.freeze(s.settings)
  return Object.freeze(s)
}

/** Obsidian's own lists, lower case and without the dot. */
export const FILE_TYPE_EXTENSIONS = {
  images: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'avif'],
  audio: ['mp3', 'wav', 'm4a', '3gp', 'flac', 'ogg', 'oga', 'opus'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'mkv'],
  pdf: ['pdf'],
} as const satisfies Record<string, readonly string[]>

type FileType = keyof typeof FILE_TYPE_EXTENSIONS

/** extension → the switch that governs it, built once. */
const TYPE_OF_EXTENSION = new Map<string, FileType>(
  (Object.keys(FILE_TYPE_EXTENSIONS) as FileType[]).flatMap((type) =>
    FILE_TYPE_EXTENSIONS[type].map((ext) => [ext, type] as const)
  )
)

/** The setting a `.obsidian/` file answers to; `never` is one this device never syncs. */
export type SettingsCategory = keyof SelectiveSettings['settings'] | 'never'

const OBSIDIAN = '.obsidian/'

/** The engine's own state folder and ignore file, which are never a vault's business. */
const ENGINE_FOLDER = '.abele-sync'
const ENGINE_IGNORE_FILE = '.abele-sync-ignore'

/**
 * True for the engine's own two paths and nothing that merely starts with their name, so a
 * vault folder called `.abele-syncnotes` still syncs. Case-insensitive: a case-insensitive
 * disk can hand the same folder back under any spelling. The scanner guards on this too,
 * so no filter of its own can let the engine's state into a commit.
 */
export function isEngineOwn(wirePath: string): boolean {
  const key = caseKey(wirePath)
  return key === ENGINE_FOLDER || key === ENGINE_IGNORE_FILE || key.startsWith(ENGINE_FOLDER + '/')
}

/**
 * True for a path any of whose segments starts with a dot — `.git/HEAD`, `.DS_Store`,
 * `Sub/.DS_Store`, `.stfolder` — except under `.obsidian/`, where the settings switches decide.
 *
 * Obsidian indexes none of these, so the plugin cannot see them, and carrying them between
 * machines does harm: a git repository interleaved from two devices, Finder's and Syncthing's
 * per-machine markers. A host that ignores them through its `PathMatcher` neither uploads nor
 * downloads them, and — since an ignored path's absence is not a delete — never removes one.
 */
export function isHidden(wirePath: string): boolean {
  if (wirePath.startsWith(OBSIDIAN)) return false
  return wirePath.split('/').some((segment) => segment.startsWith('.'))
}

// Maps, not object literals: a vault may hold a file called `constructor` or `toString`,
// and a plain object would answer those lookups with something off its prototype.

/** Files named straight under `.obsidian/`, by category. Everything else there is `never`. */
const SETTINGS_FILES = new Map<string, SettingsCategory>([
  ['app.json', 'main'],
  ['appearance.json', 'appearance'],
  ['hotkeys.json', 'hotkeys'],
  ['community-plugins.json', 'communityPlugins'],
])

/** The files a community plugin owns, by category. Its cache and the rest are `never`. */
const PLUGIN_FILES = new Map<string, SettingsCategory>([
  ['main.js', 'communityPlugins'],
  ['manifest.json', 'communityPlugins'],
  ['styles.css', 'communityPlugins'],
  ['data.json', 'pluginSettings'],
])

/**
 * Which settings switch decides a path, or `null` when the path is not under `.obsidian/`.
 *
 * `never` covers the workspace, the graph and anything unrecognised: syncing those between
 * devices moves layout and machine-local state around, which the spec rules out.
 */
export function settingsCategory(wirePath: string): SettingsCategory | null {
  if (!wirePath.startsWith(OBSIDIAN)) return null
  const rest = wirePath.slice(OBSIDIAN.length)
  const named = SETTINGS_FILES.get(rest)
  if (named) return named
  // `core-plugins*.json`: the list itself and whatever migration files Obsidian adds next.
  if (!rest.includes('/') && rest.startsWith('core-plugins') && rest.endsWith('.json')) {
    return 'corePlugins'
  }
  if (rest.startsWith('themes/') || rest.startsWith('snippets/')) return 'appearance'
  const segments = rest.split('/')
  // Exactly `plugins/<id>/<file>`: anything deeper is a plugin's own cache.
  if (segments.length === 3 && segments[0] === 'plugins') {
    return PLUGIN_FILES.get(segments[2]!) ?? 'never'
  }
  return 'never'
}

/** Trailing slashes off, so `Archive` and `Archive/` name the same folder. */
function folderPrefix(folder: string): string {
  let f = folder
  while (f.endsWith('/')) f = f.slice(0, -1)
  return f
}

/** True when this device does not sync the file at all. */
export function isExcluded(
  wirePath: string,
  size: number,
  s: SelectiveSettings,
  scriptsFolder: string
): boolean {
  if (isEngineOwn(wirePath)) return true
  if (s.maxFileBytes !== null && size > s.maxFileBytes) return true
  for (const folder of s.excludedFolders) {
    const prefix = folderPrefix(folder)
    if (prefix !== '' && wirePath.startsWith(prefix + '/')) return true
  }
  const kind = kindOf(wirePath, scriptsFolder)
  if (kind === 'note' || kind === 'canvas') return false
  if (kind === 'settings') {
    const category = settingsCategory(wirePath)
    if (category === null || category === 'never') return true
    return !s.settings[category]
  }
  if (kind === 'script') return !s.other
  const ext = splitPath(wirePath).ext.slice(1).toLowerCase()
  const type = TYPE_OF_EXTENSION.get(ext)
  return type ? !s[type] : !s.other
}
