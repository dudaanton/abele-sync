import { caseKey } from '@abele/sync-protocol'

export function isConfigurationPath(
  path: string,
  directories: readonly string[] = ['.obsidian']
): boolean {
  const first = caseKey(path.split('/')[0] ?? '')
  return first === '.obsidian' || directories.some((root) => caseKey(root) === first)
}

/** Trusted configuration roots; never supplied by a connection's display hint. */
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
  if (registry.length - 1 > 16) throw new Error('invalid registered configuration directories')
  return Object.freeze(registry)
}
