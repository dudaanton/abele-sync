import { caseKey } from '@abele/sync-protocol'
import { pathProblem } from './apply.js'
export function scopedPathAllowed(path: string, configuration: readonly string[] = []): boolean {
  return (
    pathProblem(path) === null &&
    !/\.(js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|fish|lua|rb|pl|php|ps1|bat|cmd|exe|dll|so|dylib|jar|wasm|vbs)$/i.test(
      path
    ) &&
    !['.obsidian', '.abele-sync', '.trash', ...configuration]
      .map(caseKey)
      .includes(caseKey(path).split('/')[0]!)
  )
}
