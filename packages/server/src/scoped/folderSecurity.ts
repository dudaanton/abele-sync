import {
  FolderPrefixSchema,
  caseKey,
  normalisePath,
  validatePath,
  type FileKind,
} from '@abele/sync-protocol'

export interface SecurityFacts {
  executable: 0 | 1 | null
  settings: 0 | 1 | null
  source_namespaces?: string | null
}
export interface SecurityOptions {
  configurationDirectories?: readonly string[]
}
export interface FolderFile {
  path: string
  kind: FileKind
  security?: (SecurityFacts & { source_namespaces: string | null }) | null
  withinLocalRoot?: boolean
}
export type Eligibility = {
  eligible: boolean
  reason:
    | 'in_scope'
    | 'out_of_scope'
    | 'invalid_path'
    | 'settings'
    | 'executable'
    | 'security_unknown'
    | 'local_escape'
}
const executableExtensions =
  /\.(js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|fish|lua|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm|vbs)$/i
const stateRoots = new Set(['.trash', '.abele-sync'])

/** Trusted server registration, not a scoped client's path or local attachment convention. */
export function registeredConfigurationDirectories(input: unknown): readonly string[] {
  if (
    !Array.isArray(input) ||
    input.some(
      (value) =>
        typeof value !== 'string' ||
        !value ||
        value !== value.normalize('NFC') ||
        value !== value.trim() ||
        value === '.' ||
        value === '..' ||
        value.endsWith('.') ||
        /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value) ||
        new TextEncoder().encode(value).length > 255
    )
  ) {
    throw new Error('invalid registered configuration directories')
  }
  const registry = [...new Set(['.obsidian', ...(input as string[])].map(caseKey))]
  // This function also receives its own normalized output. The built-in root is
  // mandatory and never consumes an additional-directory slot.
  if (registry.length - 1 > 16) throw new Error('invalid registered configuration directories')
  return Object.freeze(registry)
}
export function configurationPath(path: string, options: SecurityOptions = {}): boolean {
  const root = caseKey(path).split('/')[0]!
  return (
    stateRoots.has(root) ||
    registeredConfigurationDirectories(options.configurationDirectories ?? []).includes(root)
  )
}
/** Compact private provenance, not client-visible former paths. Null is incomplete. */
export function sourceNamespaces(raw: string | null | undefined): readonly string[] | null {
  if (typeof raw !== 'string' || raw.length > 32768) return null
  try {
    const values: unknown = JSON.parse(raw)
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 64 ||
      values.some(
        (value) =>
          typeof value !== 'string' ||
          !value ||
          value !== caseKey(value) ||
          (value !== '/' && /[\\\\/\u0000-\u001f\u007f]/.test(value)) ||
          new TextEncoder().encode(value).length > 255
      )
    )
      return null
    return values
  } catch {
    return null
  }
}
export function inheritedNamespaces(
  path: string,
  sources: readonly (readonly string[] | null)[]
): readonly string[] | null {
  if (sources.some((source) => source === null)) return null
  const current = path.includes('/') ? caseKey(path).split('/')[0]! : '/'
  const roots = [...new Set([current, ...sources.flatMap((source) => source ?? [])])]
  return roots.length <= 64 ? roots : null
}
export function namespaceIsRestricted(
  roots: readonly string[],
  options: SecurityOptions = {}
): boolean {
  return roots.some((root) => configurationPath(root, options))
}

export function pathSecurity(
  path: string,
  kind: FileKind,
  options: SecurityOptions = {}
): SecurityFacts {
  return {
    executable: kind === 'script' || executableExtensions.test(path) ? 1 : 0,
    settings: kind === 'settings' || configurationPath(path, options) ? 1 : 0,
  }
}
/** Positive restrictions dominate unknown and cannot be cleared by path/body edits. Only
 * proven original creation or complete source facts can establish negative classifications.
 */
export function reduceSecurity(
  path: string,
  kind: FileKind,
  sources: readonly (SecurityFacts | null)[],
  originalCreation: boolean,
  options: SecurityOptions = {}
): SecurityFacts {
  const current = pathSecurity(path, kind, options)
  const field = (key: 'executable' | 'settings'): 0 | 1 | null => {
    if (current[key] === 1 || sources.some((source) => source?.[key] === 1)) return 1
    if (
      (!originalCreation && sources.length === 0) ||
      sources.some((source) => source === null || source[key] === null)
    )
      return null
    return 0
  }
  return { executable: field('executable'), settings: field('settings') }
}
export function scopedSecurityEligibility(
  file: FolderFile,
  options: SecurityOptions = {}
): Eligibility {
  if (file.withinLocalRoot === false) return { eligible: false, reason: 'local_escape' }
  const namespaces = sourceNamespaces(file.security?.source_namespaces)
  if (
    configurationPath(file.path, options) ||
    file.security?.settings === 1 ||
    file.kind === 'settings' ||
    (namespaces !== null && namespaceIsRestricted(namespaces, options))
  )
    return { eligible: false, reason: 'settings' }
  try {
    validatePath(file.path)
    if (normalisePath(file.path) !== file.path) throw new Error('noncanonical')
  } catch {
    return { eligible: false, reason: 'invalid_path' }
  }
  if (
    pathSecurity(file.path, file.kind, options).executable === 1 ||
    file.security?.executable === 1
  )
    return { eligible: false, reason: 'executable' }
  if (
    !file.security ||
    file.security.executable !== 0 ||
    file.security.settings !== 0 ||
    namespaces === null
  )
    return { eligible: false, reason: 'security_unknown' }
  return { eligible: true, reason: 'in_scope' }
}
export function folderEligibility(
  prefix: string,
  file: FolderFile,
  options: SecurityOptions = {}
): Eligibility {
  const security = scopedSecurityEligibility(file, options)
  if (!security.eligible) return security
  try {
    FolderPrefixSchema.parse(prefix)
  } catch {
    return { eligible: false, reason: 'invalid_path' }
  }
  return caseKey(file.path).startsWith(caseKey(prefix))
    ? { eligible: true, reason: 'in_scope' }
    : { eligible: false, reason: 'out_of_scope' }
}

/** Recipient writes cannot self-admit private identities or move across the folder boundary. */
export function folderMutation(
  prefix: string,
  op: 'create' | 'modify' | 'move' | 'delete' | 'restore',
  before: FolderFile | null,
  after: FolderFile | null,
  options: SecurityOptions = {}
): Eligibility {
  if (op !== 'create') {
    if (!before) return { eligible: false, reason: 'out_of_scope' }
    const prior = folderEligibility(prefix, before, options)
    if (!prior.eligible) return prior
  } else if (before !== null) return { eligible: false, reason: 'out_of_scope' }
  if (op === 'delete') return { eligible: true, reason: 'in_scope' }
  return after
    ? folderEligibility(prefix, after, options)
    : { eligible: false, reason: 'out_of_scope' }
}
/** Owner transitions are admission changes, never synthetic deletes or path remaps. */
export function folderTransition(
  prefix: string,
  before: FolderFile | null,
  after: FolderFile | null,
  options: SecurityOptions = {}
): 'enter' | 'leave' | 'stay' | 'absent' {
  const prior = before !== null && folderEligibility(prefix, before, options).eligible
  const next = after !== null && folderEligibility(prefix, after, options).eligible
  return prior ? (next ? 'stay' : 'leave') : next ? 'enter' : 'absent'
}
