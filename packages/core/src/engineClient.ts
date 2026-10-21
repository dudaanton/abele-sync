import type {
  CommitOp,
  CommitOpResult,
  CommitResponse,
  ChangesResponse,
  ManifestResponse,
  VersionInfo,
  VaultState,
} from '@abele/sync-protocol'
import type { FileSystem } from './fs.js'
import type { StateStore } from './state.js'
import type { ChunkSource, ContentIdentity } from './streaming.js'

export interface CommitOutcome {
  body: CommitResponse
  replayed: boolean
}
export interface VersionsQuery {
  limit?: number
  before?: number
}

/** Portable transport consumed by the retained scanner/pull/push/journal engine.
 * Neither an account client nor an authority-selecting adapter. */
export interface EngineClient {
  openVersion?(
    fileId: string,
    versionId: string,
    expected: ContentIdentity,
    signal?: AbortSignal
  ): Promise<ChunkSource>
  putBlobSource?(
    expected: ContentIdentity,
    source: ChunkSource,
    signal?: AbortSignal,
    maxChunkBytes?: number
  ): Promise<void>
  state(): Promise<VaultState>
  manifest(cursor: string | null, limit?: number, signal?: AbortSignal): Promise<ManifestResponse>
  /** Restore transport membership/content lookup caches from a durable manifest snapshot. */
  rememberManifest?(
    items: readonly import('@abele/sync-protocol').ManifestItem[]
  ): void | Promise<void>
  changes(since: number, limit?: number, signal?: AbortSignal): Promise<ChangesResponse>
  commitRaw(ops: CommitOp[], key: string): Promise<CommitOutcome>
  commit(ops: CommitOp[], key: string): Promise<CommitResponse>
  hasBlob(sha: string): Promise<boolean>
  getBlob(sha: string, signal?: AbortSignal): Promise<Uint8Array>
  putBlob(sha: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>
  versions(fileId: string, query?: VersionsQuery): Promise<VersionInfo[]>
  versionBytes(fileId: string, versionId: string, signal?: AbortSignal): Promise<Uint8Array>
  restore(fileId: string, versionId: string, key?: string): Promise<CommitOpResult>
  restoreDeleted(fileId: string, key?: string): Promise<CommitOpResult>
  restoreDeletedMany(fileIds: string[], key?: string): Promise<CommitOpResult[]>
  subscribe(onSeq: (seq: number) => void, onClose: (why: string) => void): () => void
  /** Read decoding may apply durable directory and scope-departure effects. */
  readonly readEffects?: true
  /** Report oversized local files as upload refusals instead of excluding them silently.
   * Remote files above the server limit remain excluded from pulls. */
  readonly reportSizeRefusals?: true
  includes?(path: string): boolean
  prepare?(
    fs: FileSystem,
    state: StateStore,
    excludeDirectory?: (path: string) => boolean,
    signal?: AbortSignal,
    deferLocalScan?: boolean
  ): Promise<void>
  scanLocal?(fs: FileSystem, signal?: AbortSignal, changed?: ReadonlySet<string>): Promise<void>
  syncDirectories?(): Promise<void>
  finishPull?(): Promise<void>
}
