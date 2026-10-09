import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { link, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import { kindOf } from '@abele/sync-protocol'
import {
  decodeExternalDocument,
  ExternalStateError,
  sameConnection,
  ConnectionBindingSchema,
  LocalBaseSchema,
  ExternalRecordSchema,
  ScopedKnownFileSchema,
  ScopedConnectionSchema,
  ScopedState,
  type ConnectionBinding,
  type ExternalOperation,
  type ExternalDocument,
} from '@abele/sync-core'
import { parseLocalDescriptor, stateFolder, type LocalDescriptor } from './config.js'
import {
  assertLocalSafety,
  inspectProjectionInventory,
  ACTIVATION_FILE,
  type LifecycleInventory,
} from './externalSafety.js'
import { containedIn, absoluteIn, isMissing } from './nodeFsGuard.js'
import { NodeFileSystem } from './nodeFs.js'
import { SqliteStateStore } from './sqliteState.js'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`
export const READY_KEY = 'external-disconnect-ready'
type Base = NonNullable<ExternalOperation['localBase']>
interface Proof {
  base: Base
  identity: string
  path?: string
}
interface Ready {
  binding: ConnectionBinding
  revision: number
  files: Proof[]
}
export interface DisconnectMaterializer {
  verify(base: Base, effectGuard: () => void): Promise<void>
  download(base: Base, effectGuard: () => void): Promise<Uint8Array>
  scriptsFolder: string | ((effectGuard: () => void) => Promise<string>)
}
export type MaterializationBoundary =
  | 'download-intent'
  | 'staging-written'
  | 'ready-to-install'
  | 'installed'
  | 'hydrated'
  | 'projection-removed'
  | 'ready'
function refuse(why: string): never {
  const error = new ExternalStateError('recovery-required')
  error.message = `disconnect-incomplete: ${why}; connection and inventory were preserved`
  throw error
}
/** Validate activation against the actual opened file. Never initialize missing evidence. */
export async function validateLifecycleLedger(
  dir: string,
  ledgerFile: 'state.db' | 'agent.sqlite',
  binding: ConnectionBinding,
  raw: SqliteStateStore
): Promise<LocalDescriptor | null> {
  const configFile = ledgerFile === 'state.db' ? 'config.json' : 'agent.json'
  const config = JSON.parse(readFileSync(join(stateFolder(dir), configFile), 'utf8')) as {
    descriptor?: unknown
    connection?: { binding?: unknown }
    binding?: unknown
  }
  if (ledgerFile === 'agent.sqlite') {
    const scoped = ScopedConnectionSchema.parse(config.connection?.binding ?? config.binding)
    if (
      !sameConnection(binding, {
        endpoint: scoped.endpoint_identity,
        vaultId: scoped.vault_id,
        mode: 'scoped',
        principalId: scoped.principal_id,
        principalType: scoped.principal_kind,
        grantId: scoped.grant_id,
        generation: binding.generation,
        credentialAssociation: scoped.credential_fingerprint,
      })
    )
      refuse('foreign scoped root binding')
    await ScopedState.open(raw, scoped)
  }
  const descriptor =
    config.descriptor === undefined ? null : parseLocalDescriptor(config.descriptor)
  const marker = join(stateFolder(dir), ACTIVATION_FILE)
  if (descriptor || existsSync(marker)) {
    if (!descriptor || !existsSync(marker)) refuse('missing activation/descriptor')
    const activation = JSON.parse(readFileSync(marker, 'utf8')) as {
      format: string
      schema: number
      state: string
      ledgerFile: string
      descriptor: unknown
    }
    if (
      activation.format !== 'abele.external.activation' ||
      activation.schema !== 1 ||
      activation.state !== 'active' ||
      activation.ledgerFile !== ledgerFile ||
      JSON.stringify(parseLocalDescriptor(activation.descriptor)) !== JSON.stringify(descriptor) ||
      raw.readExternalInstanceId() !== descriptor.instanceId ||
      !sameConnection(descriptor.binding, binding)
    )
      refuse('activation identity changed')
  }
  const value = raw.getMeta('external-files')
  if (descriptor && value === null) refuse('activated inventory missing')
  if (value !== null) {
    const doc = decodeExternalDocument(value)
    if (
      !sameConnection(doc.binding, binding) ||
      (descriptor && doc.ledgerId !== descriptor.ledgerId)
    )
      refuse('foreign inventory')
  }
  return descriptor
}
/** Ready is a durable receipt, not permission to forget a later changed/replaced original. */
export function assertDisconnectReady(
  dir: string,
  raw: Pick<SqliteStateStore, 'getMeta'>,
  doc: ExternalDocument
): void {
  if (doc.files.length || doc.operations.length) refuse('unresolved inventory')
  const text = raw.getMeta(READY_KEY)
  if (text === null) refuse('preparation receipt missing')
  const ready = JSON.parse(text) as Ready
  ConnectionBindingSchema.parse(ready.binding)
  if (Object.keys(ready).some((key) => !['binding', 'revision', 'files'].includes(key)))
    refuse('malformed preparation receipt')
  if (
    !sameConnection(ready.binding, doc.binding) ||
    ready.revision !== doc.revision ||
    !Array.isArray(ready.files)
  )
    refuse('preparation revision changed')
  for (const proof of ready.files) {
    LocalBaseSchema.parse(proof.base)
    if (
      typeof proof.identity !== 'string' ||
      Object.keys(proof).some((key) => !['base', 'identity', 'path'].includes(key))
    )
      refuse('malformed local proof')
    const path = proof.path ?? proof.base.path
    ExternalRecordSchema.shape.projectionPath.parse(path)
    const target = absoluteIn(dir, path)
    let current = dir
    for (const segment of path.split('/')) {
      current = join(current, segment)
      if (lstatSync(current).isSymbolicLink()) refuse(`unsafe materialized path ${proof.base.path}`)
    }
    const stat = lstatSync(target)
    if (
      !stat.isFile() ||
      identity(stat) !== proof.identity ||
      stat.size !== proof.base.size ||
      digest(readFileSync(target)) !== proof.base.sha
    )
      refuse(`local-changed: ${proof.base.path}`)
  }
}
/** Same synchronous final inventory gate for disconnect, replacement and delayed retirement.
 * The switch coordinator separately fences transitional descriptor/activation writes.
 */
export function assertPreparedInventory(
  dir: string,
  ledgerFile: 'state.db' | 'agent.sqlite',
  bindings: ConnectionBinding[],
  recoveringSwitch = false
): void {
  const file = join(stateFolder(dir), ledgerFile)
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) refuse('bound ledger missing')
  const db = new SqliteDatabase(file, { readonly: true, fileMustExist: true })
  try {
    const meta = (key: string) =>
      (
        db.prepare('SELECT value FROM meta WHERE key = ?').get(`daemon:${key}`) as
          { value: string } | undefined
      )?.value ?? null
    const doc = decodeExternalDocument(meta('external-files') ?? '')
    if (!bindings.some((binding) => sameConnection(doc.binding, binding)))
      refuse('foreign prepared binding')
    assertDisconnectReady(dir, { getMeta: meta }, doc)
    assertLocalSafety(dir, true, true, false, false, recoveringSwitch, {
      ledgerFile,
      binding: doc.binding,
      projections: new Set(),
    })
  } finally {
    db.close()
  }
}
/** Explicit lifecycle preparation under the physical-vault lock; no ordinary sync or Restore.
 * A persisted staging inode proves interrupted link installation. Equal bytes alone never do.
 */
export async function materializeForDisconnect(
  dir: string,
  ledgerFile: 'state.db' | 'agent.sqlite',
  binding: ConnectionBinding,
  client: DisconnectMaterializer,
  guard: () => void,
  afterWrite: (phase: MaterializationBoundary) => void = () => {}
): Promise<void> {
  guard()
  const file = join(stateFolder(dir), ledgerFile)
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) refuse('bound ledger missing')
  let effectCheck = guard
  const raw = SqliteStateStore.open(file, { effectGuard: () => effectCheck() })
  try {
    let instance = raw.readExternalInstanceId()
    const physical = identity(lstatSync(file))
    const config = join(stateFolder(dir), ledgerFile === 'state.db' ? 'config.json' : 'agent.json'),
      stamp = digest(readFileSync(config))
    const activationFile = join(stateFolder(dir), ACTIVATION_FILE)
    const activationStamp = existsSync(activationFile) ? digest(readFileSync(activationFile)) : null
    const check = () => {
      guard()
      if (
        !raw.isLedgerFile(file) ||
        identity(lstatSync(file)) !== physical ||
        raw.readExternalInstanceId() !== instance ||
        digest(readFileSync(config)) !== stamp ||
        (existsSync(activationFile) ? digest(readFileSync(activationFile)) : null) !==
          activationStamp
      )
        refuse('connection or physical ledger changed')
    }
    effectCheck = check
    await validateLifecycleLedger(dir, ledgerFile, binding, raw)
    check()
    if (instance === null) instance = raw.getExternalInstanceId()
    check()
    const value = await raw.getExternalState()
    check()
    if (value === null) {
      assertLocalSafety(dir, true)
      await inspectProjectionInventory(dir, { guard: check })
      return
    }
    let doc = decodeExternalDocument(value)
    const inventory: LifecycleInventory = {
      ledgerFile,
      binding,
      projections: new Set(doc.files.flatMap((f) => (f.projectionPath ? [f.projectionPath] : []))),
      materializing: new Set(doc.files.map((f) => f.fileId)),
      staging: new Set(
        doc.operations
          .filter(
            (op) =>
              op.kind === 'hydration' &&
              op.operationId.startsWith('disconnect:') &&
              ['download-intent', 'ready-to-install', 'hydrated'].includes(op.phase) &&
              op.expected &&
              doc.files.some((f) => f.fileId === op.expected!.fileId) &&
              op.sourcePath ===
                `.abele-sync/disconnect-staging/${digest(Buffer.from(op.operationId))}`
          )
          .map((op) => op.sourcePath!)
      ),
    }
    check()
    assertLocalSafety(dir, true, true, false, false, false, inventory)
    await inspectProjectionInventory(dir, { guard: check, ownedProjections: inventory.projections })
    if (raw.getMeta(READY_KEY) !== null) {
      assertDisconnectReady(dir, raw, doc)
      return
    }
    const disk = new NodeFileSystem(dir, { effectGuard: check })
    const commit = async (
      next: ExternalDocument,
      metadata?: { key: string; value: string | null }[]
    ) => {
      check()
      await raw.commitExternalPhase({
        expectedRevision: doc.revision,
        next: JSON.stringify({ ...next, revision: doc.revision + 1 }),
        ledger: { metadata },
      })
      doc = decodeExternalDocument((await raw.getExternalState())!)
    }
    // Terminal eviction/tombstone bookkeeping can be retired only with all of its file dependencies.
    for (const op of doc.operations) {
      if (op.operationId.startsWith('disconnect:') && op.kind === 'hydration') {
        if (
          !op.expected ||
          !doc.files.some(
            (f) => f.fileId === op.expected!.fileId && op.operationId === `disconnect:${f.fileId}`
          )
        )
          refuse(`orphan disconnect operation ${op.operationId}`)
        continue
      }
      if (
        !['complete', 'remote-only', 'tombstone', 'detached'].includes(op.phase) ||
        op.unresolvedOutcome ||
        op.cleanupReason ||
        op.ownedArtifacts.length ||
        doc.files.some((f) => f.pendingOperationId === op.operationId)
      )
        refuse(`unresolved operation ${op.operationId}`)
    }
    const proofs: Proof[] = []
    for (const initial of [...doc.files]) {
      check()
      let record = doc.files.find((f) => f.fileId === initial.fileId)!
      if (record.blockingReason || ['unavailable', 'detached'].includes(record.availability))
        refuse(`${record.fileId}: ${record.blockingReason ?? record.availability}`)
      if (record.retained.length) refuse(`${record.fileId}: retained bytes require recovery`)
      const entry = await raw.byFileId(record.fileId)
      const knownText =
        binding.mode === 'scoped' ? raw.getMeta(`scoped-v4-file:${record.fileId}`) : null
      const known = knownText ? ScopedKnownFileSchema.parse(JSON.parse(knownText)) : null
      if (
        known &&
        (known.dirty ||
          ['held', 'detached'].includes(known.state) ||
          known.file_id !== record.fileId)
      )
        refuse(`${record.fileId}: unresolved scoped placement`)
      const base: Base | null =
        record.availability === 'deleted'
          ? record.lastProvenLocalBase
          : entry
            ? {
                fileId: entry.fileId,
                versionId: entry.versionId,
                path: entry.wirePath,
                sha: entry.sha,
                size: entry.size,
                mtime: entry.mtime,
              }
            : known
              ? {
                  fileId: known.file_id,
                  versionId: known.version_id,
                  path: known.path,
                  sha: known.sha,
                  size: known.size,
                  mtime: known.mtime,
                }
              : record.lastProvenLocalBase
      if (!base) refuse(`${record.fileId}: version basis missing`)
      const physicalTarget = entry?.path ?? base.path
      ExternalRecordSchema.shape.projectionPath.parse(physicalTarget)
      const scriptsFolder =
        typeof client.scriptsFolder === 'string'
          ? client.scriptsFolder
          : await client.scriptsFolder(check)
      check()
      if (
        kindOf(base.path, scriptsFolder) !== 'attachment' ||
        kindOf(physicalTarget.normalize('NFC'), scriptsFolder) !== 'attachment'
      )
        refuse(
          `${record.fileId}: approval-required/ineligible; use normal permitted materialization`
        )
      const opId = `disconnect:${record.fileId}`
      let op = doc.operations.find((o) => o.operationId === opId)
      if (record.pendingOperationId && record.pendingOperationId !== opId)
        refuse(`${record.fileId}: unfinished operation`)
      if (
        op &&
        (op.kind !== 'hydration' ||
          !op.expected ||
          op.expected.versionId !== base.versionId ||
          op.expected.sha !== base.sha ||
          op.expected.path !== base.path ||
          op.expected.size !== base.size ||
          op.unresolvedOutcome ||
          !['download-intent', 'ready-to-install', 'hydrated', 'complete'].includes(op.phase))
      )
        refuse(`${record.fileId}: version-changed/recovery-required`)
      if (record.projectionPath) {
        const stat = await disk.stat(record.projectionPath)
        if (stat && digest(await disk.read(record.projectionPath)) !== record.projectionSha)
          refuse(`${record.fileId}: projection changed`)
        if (!stat && (!op || !['hydrated', 'complete'].includes(op.phase)))
          refuse(`${record.fileId}: projection missing`)
      }
      const stage = `.abele-sync/disconnect-staging/${digest(Buffer.from(opId))}`
      if (!op && record.representation !== 'hydrated') {
        if (await disk.stat(physicalTarget)) refuse(`${record.fileId}: collision`)
        if (record.availability === 'active') await client.verify(base, check)
        check()
        op = {
          schema: 1,
          operationId: opId,
          kind: 'hydration',
          phase: 'download-intent',
          revision: 0,
          connectionGeneration: binding.generation,
          expected: {
            fileId: base.fileId,
            versionId: base.versionId,
            path: base.path,
            sha: base.sha,
            size: base.size,
          },
          sourcePath: stage,
          targetPath: physicalTarget,
          previousRepresentation: record.representation,
          localBase: base,
          desiredRepresentation: 'hydrated',
          projectionDigest: record.projectionSha,
          ownedArtifacts: [],
          unresolvedOutcome: null,
          cleanupReason: null,
        }
        await commit({
          ...doc,
          operations: [...doc.operations, op],
          files: doc.files.map((f) =>
            f.fileId === record.fileId
              ? { ...f, pendingOperationId: opId, localRevision: f.localRevision + 1 }
              : f
          ),
        })
        afterWrite('download-intent')
      }
      if (
        op &&
        (op.sourcePath !== stage ||
          op.targetPath !== physicalTarget ||
          op.expected?.fileId !== base.fileId ||
          op.desiredRepresentation !== 'hydrated')
      )
        refuse(`${record.fileId}: foreign installation intent`)
      if (op && op.phase === 'download-intent') {
        if (record.availability === 'active') await client.verify(base, check)
        check()
        let staged = await disk.stat(stage)
        if (!staged) {
          const bytes = await client.download(base, check)
          check()
          if (bytes.length !== base.size || digest(bytes) !== base.sha)
            refuse(`${record.fileId}: version-changed; digest/size mismatch`)
          const path = await containedIn(dir, stage)
          check()
          await mkdir(dirname(path), { recursive: true })
          await containedIn(dir, stage)
          check()
          await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
          afterWrite('staging-written')
          staged = await disk.stat(stage)
        }
        if (staged?.size !== base.size || digest(await disk.read(stage)) !== base.sha)
          refuse(`${record.fileId}: staged version-changed`)
        op = {
          ...op,
          phase: 'ready-to-install',
          revision: op.revision + 1,
          ownedArtifacts: [
            { path: stage, sha: base.sha, size: base.size, role: 'incoming', operationId: opId },
          ],
        }
        await commit({
          ...doc,
          operations: doc.operations.map((o) => (o.operationId === opId ? op! : o)),
        })
        afterWrite('ready-to-install')
      }
      if (op && op.phase === 'ready-to-install') {
        if (record.availability === 'active') await client.verify(base, check)
        check()
        const source = await containedIn(dir, stage),
          target = await containedIn(dir, physicalTarget)
        const staged = await lstat(source)
        if (
          !staged.isFile() ||
          staged.isSymbolicLink() ||
          staged.size !== base.size ||
          digest(await disk.read(stage)) !== base.sha
        )
          refuse(`${record.fileId}: staging changed`)
        check()
        await mkdir(dirname(target), { recursive: true })
        await containedIn(dir, physicalTarget)
        check()
        let named = await lstat(target).catch((error) => {
          if (isMissing(error)) return null
          throw error
        })
        if (named && (named.isSymbolicLink() || identity(named) !== identity(staged)))
          refuse(`${record.fileId}: collision; equal bytes are not installation evidence`)
        if (!named) {
          try {
            check()
            await link(source, target)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
              refuse(`${record.fileId}: collision`)
            throw error
          }
          afterWrite('installed')
          named = await lstat(target)
        }
        check()
        if (
          identity(named) !== identity(staged) ||
          digest(await disk.read(physicalTarget)) !== base.sha
        )
          refuse(`${record.fileId}: ambiguous installation`)
        op = { ...op, phase: 'hydrated', revision: op.revision + 1 }
        await commit(
          {
            ...doc,
            operations: doc.operations.map((o) => (o.operationId === opId ? op! : o)),
            files: doc.files.map((f) =>
              f.fileId === record.fileId
                ? {
                    ...f,
                    representation: 'hydrated',
                    lastProvenLocalBase: base,
                    localRevision: f.localRevision + 1,
                  }
                : f
            ),
          },
          [
            { key: `external-install:${digest(Buffer.from(opId))}`, value: identity(named) },
            ...(known && record.availability === 'active'
              ? [
                  {
                    key: `scoped-v4-file:${record.fileId}`,
                    value: JSON.stringify({ ...known, state: 'materialized' }),
                  },
                ]
              : []),
          ]
        )
        afterWrite('hydrated')
      }
      const target = await containedIn(dir, physicalTarget),
        installed = await lstat(target)
      check()
      if (
        !installed.isFile() ||
        installed.isSymbolicLink() ||
        installed.size !== base.size ||
        digest(await disk.read(physicalTarget)) !== base.sha ||
        (op && raw.getMeta(`external-install:${digest(Buffer.from(opId))}`) !== identity(installed))
      )
        refuse(`${record.fileId}: local-changed`)
      proofs.push({ base, path: physicalTarget, identity: identity(installed) })
      if (record.projectionPath && (await disk.stat(record.projectionPath))) {
        if (digest(await disk.read(record.projectionPath)) !== record.projectionSha)
          refuse(`${record.fileId}: projection changed`)
        check()
        await disk.remove(record.projectionPath)
        afterWrite('projection-removed')
      }
      if (op) {
        if (await disk.stat(stage)) {
          if (digest(await disk.read(stage)) !== base.sha)
            refuse(`${record.fileId}: retained staging changed`)
          check()
          await disk.remove(stage)
        }
        op = { ...op, phase: 'complete', revision: op.revision + 1, ownedArtifacts: [] }
      }
      await commit({
        ...doc,
        operations: doc.operations.map((o) => (o.operationId === opId ? op! : o)),
        files: doc.files.map((f) =>
          f.fileId === record.fileId
            ? {
                ...f,
                representation: 'hydrated',
                projectionPath: null,
                projectionSha: null,
                pendingOperationId: null,
                localRevision: f.localRevision + 1,
              }
            : f
        ),
      })
    }
    check()
    // Reinspect the whole tree; damaged/renamed/orphan projections are never discarded.
    await inspectProjectionInventory(dir, { guard: check, ownedProjections: inventory.projections })
    // Retire positive cache entries only after recorded owned projections were actually removed.
    const index = join(stateFolder(dir), 'projection-index.json')
    if (existsSync(index)) {
      const data = JSON.parse(await readFile(index, 'utf8')) as {
        entries: { path: string; marker: boolean }[]
      }
      if (data.entries.some((e) => e.marker && existsSync(join(dir, e.path))))
        refuse('projection cleanup incomplete')
      check()
      await unlink(index)
    }
    const ready: Ready = { binding, revision: doc.revision + 1, files: proofs }
    await commit({ ...doc, files: [], operations: [] }, [
      { key: READY_KEY, value: JSON.stringify(ready) },
    ])
    assertDisconnectReady(dir, raw, doc)
    afterWrite('ready')
  } catch (cause) {
    const seen = new Set<unknown>()
    for (
      let error = cause;
      error && typeof error === 'object' && !seen.has(error);
      error = (error as { cause?: unknown }).cause
    ) {
      seen.add(error)
      if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? ''))
        refuse('no-space; verified staging and inventory retained')
    }
    throw cause
  } finally {
    raw.close()
  }
}
