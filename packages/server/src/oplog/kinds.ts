import { kindOf, type FileKind, type VaultSettings } from '@abele/sync-protocol'

/** What a path holds in this vault: `kindOf` with the vault's own scripts folder. */
export function fileKind(path: string, settings: VaultSettings): FileKind {
  return kindOf(path, settings.scripts_folder)
}
