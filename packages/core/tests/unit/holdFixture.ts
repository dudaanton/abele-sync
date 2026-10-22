import type { ChangeItem } from '@abele/sync-protocol'
import { sha256 } from '../../src/hash.js'

export async function change(n: number): Promise<ChangeItem> {
  return {
    seq: n + 1,
    file_id: `f${n}`,
    version_id: `v${n}`,
    path: `${n}.bin`,
    prev_path: null,
    op: 'modify',
    sha: await sha256(new Uint8Array([1])),
    size: 1,
    mtime: 1,
    kind: 'attachment',
    actor: { kind: 'system', id: 'server', name: 'server' },
    at: '',
  }
}
