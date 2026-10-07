import { z } from 'zod'
import { ERROR_CODES } from './errors.js'
import { FILE_KINDS } from './paths.js'

/* ── Primitives ─────────────────────────────────────────────────────────── */

/** A content hash: 64 lowercase hex characters. */
export const ShaSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type Sha = z.infer<typeof ShaSchema>

/** A vault path. The full rules live in `validatePath`; the wire only bounds the length. */
export const PathSchema = z.string().min(1).max(1024)
export type Path = z.infer<typeof PathSchema>

/** Every error code the protocol can carry, from the one list in `errors.ts`. */
export const ErrorCodeSchema = z.enum(ERROR_CODES)

/** Every file kind, from the one list in `paths.ts`. */
export const FileKindSchema = z.enum(FILE_KINDS)

/** Bytes: a non-negative integer. */
const bytes = z.number().int().nonnegative()
/** A tally: a non-negative integer. */
const count = z.number().int().nonnegative()
/** Milliseconds since the epoch: a non-negative integer. */
const mtime = z.number().int().nonnegative()
/** A vault sequence number. Sequences start at 1. */
const seq = z.number().int().positive()
/** The sequence a vault has reached. An empty vault is at 0. */
const headSeq = z.number().int().nonnegative()
/** An ISO-8601 timestamp, in UTC or with an offset. */
const timestamp = z.string().datetime({ offset: true })
const id = z.string().min(1)

const PlatformSchema = z.enum(['desktop', 'mobile', 'daemon'])

/** Who made a change: a device, a signing key, or the server itself. */
export const ActorSchema = z.object({
  kind: z.enum(['device', 'key', 'system']),
  id,
  name: z.string(),
})
export type Actor = z.infer<typeof ActorSchema>

/** What a version did to its file. */
export const VersionOpSchema = z.enum([
  'create',
  'modify',
  'delete',
  'move',
  'restore',
  'merge',
  'conflict',
])
export type VersionOp = z.infer<typeof VersionOpSchema>

/* ── Account and device ─────────────────────────────────────────────────── */

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})
export type LoginRequest = z.infer<typeof LoginRequestSchema>

export const LoginResponseSchema = z.object({
  account_token: z.string(),
  expires_at: timestamp,
})
export type LoginResponse = z.infer<typeof LoginResponseSchema>

/** Longer than any name a person gives a device; the cap keeps a token from storing essays. */
export const DEVICE_NAME_MAX = 200

export const EnrolDeviceRequestSchema = z.object({
  vault_id: id,
  name: z.string().min(1).max(DEVICE_NAME_MAX),
  platform: PlatformSchema,
})
export type EnrolDeviceRequest = z.infer<typeof EnrolDeviceRequestSchema>

export const EnrolDeviceResponseSchema = z.object({
  device_id: id,
  device_token: z.string(),
})
export type EnrolDeviceResponse = z.infer<typeof EnrolDeviceResponseSchema>

/**
 * A device asks for another device on its own vault: what a transfer hands to
 * the device it sets up, so the two never share one token.
 */
export const EnrolSiblingRequestSchema = EnrolDeviceRequestSchema.omit({ vault_id: true })
export type EnrolSiblingRequest = z.infer<typeof EnrolSiblingRequestSchema>

export const DeviceInfoSchema = z.object({
  id,
  name: z.string(),
  platform: PlatformSchema,
  vault_id: id,
  last_seen_at: timestamp.nullable(),
  created_at: timestamp,
  /** The device whose token asked for this one; null when an account enrolled it. */
  enrolled_by: id.nullable().default(null),
})
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>

/* ── Vault ──────────────────────────────────────────────────────────────── */

/** What a vault holds, in bytes, live and in history and in the trash. */
export const UsageSchema = z.object({
  live_bytes: bytes,
  history_bytes: bytes,
  trash_bytes: bytes,
  quota_bytes: bytes.nullable(),
  by_kind: z.record(FileKindSchema, z.object({ live_bytes: bytes, count })),
})
export type Usage = z.infer<typeof UsageSchema>

export const VaultInfoSchema = z.object({
  id,
  name: z.string(),
  role: z.enum(['owner', 'member']),
  usage: UsageSchema,
})
export type VaultInfo = z.infer<typeof VaultInfoSchema>

/** How long each kind of file keeps its history, in days. */
const RetentionSchema = z.object({
  notes_days: z.number().int().nonnegative().default(365),
  attachments_days: z.number().int().nonnegative().default(14),
  settings_days: z.number().int().nonnegative().default(30),
})

/** The vault's own settings. Every field has a default, so `{}` parses to the defaults. */
export const VaultSettingsSchema = z.object({
  conflict: z.enum(['merge', 'conflict-file']).default('merge'),
  max_file_bytes: z
    .number()
    .int()
    .positive()
    .default(200 * 1024 * 1024),
  quota_bytes: bytes.nullable().default(null),
  retention: RetentionSchema.default({}),
  scripts_folder: z.string().default('Scripts'),
  key_signature: z
    .object({ enabled: z.boolean(), property: z.string(), value: z.string() })
    .nullable()
    .default(null),
})
export type VaultSettings = z.infer<typeof VaultSettingsSchema>

/**
 * A change to some of those settings: any field, and `retention` any of its own.
 *
 * `partial()` alone would not do. It stops at the top level, so a patch that says
 * nothing about retention would still carry `retention`'s own defaults and quietly
 * reset every span the caller left out.
 */
export const VaultSettingsPatchSchema = VaultSettingsSchema.partial().extend({
  retention: VaultSettingsSchema.shape.retention.removeDefault().partial().optional(),
})
export type VaultSettingsPatch = z.infer<typeof VaultSettingsPatchSchema>

/** Password proof is request-only: never part of stored or returned vault settings. */
export const VaultSettingsUpdateRequestSchema = VaultSettingsPatchSchema.extend({
  account_password: LoginRequestSchema.shape.password.optional(),
})
export type VaultSettingsUpdateRequest = z.infer<typeof VaultSettingsUpdateRequestSchema>

export const VaultStateSchema = z.object({
  head_seq: headSeq,
  settings: VaultSettingsSchema,
  usage: UsageSchema,
})
export type VaultState = z.infer<typeof VaultStateSchema>

/* ── Manifest ───────────────────────────────────────────────────────────── */

export const ManifestItemSchema = z.object({
  file_id: id,
  path: PathSchema,
  kind: FileKindSchema,
  version_id: id,
  seq,
  sha: ShaSchema,
  size: bytes,
  mtime,
})
export type ManifestItem = z.infer<typeof ManifestItemSchema>

export const ManifestResponseSchema = z.object({
  items: z.array(ManifestItemSchema),
  next: z.string().nullable(),
  head_seq: headSeq,
})
export type ManifestResponse = z.infer<typeof ManifestResponseSchema>

/* ── Changes ────────────────────────────────────────────────────────────── */

export const ChangeItemSchema = z.object({
  seq,
  file_id: id,
  op: VersionOpSchema,
  path: PathSchema,
  prev_path: PathSchema.nullable(),
  sha: ShaSchema.nullable(),
  size: bytes.nullable(),
  mtime: mtime.nullable(),
  version_id: id,
  kind: FileKindSchema,
  actor: ActorSchema,
  at: timestamp,
})
export type ChangeItem = z.infer<typeof ChangeItemSchema>

export const ChangesResponseSchema = z.object({
  items: z.array(ChangeItemSchema),
  head_seq: headSeq,
  next_since: headSeq,
})
export type ChangesResponse = z.infer<typeof ChangesResponseSchema>

/* ── Commit ─────────────────────────────────────────────────────────────── */

/**
 * Which side a create takes when the path already holds a live file with other bytes, sent
 * only while a device joins a vault it already has files for: `mine` makes the op's bytes the
 * head, `theirs` keeps the head. Either way the loser is a version of that file. Absent, the
 * server decides as for any create (§6). A server older than this field strips it and decides
 * as if it were absent, which is "merge both".
 */
export const JoinPreferSchema = z.enum(['mine', 'theirs'])
export type JoinPrefer = z.infer<typeof JoinPreferSchema>

export const CommitOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    path: PathSchema,
    sha: ShaSchema,
    size: bytes,
    mtime,
    prefer: JoinPreferSchema.optional(),
  }),
  z.object({
    op: z.literal('modify'),
    file_id: id,
    base_version_id: id,
    sha: ShaSchema,
    size: bytes,
    mtime,
  }),
  z.object({ op: z.literal('delete'), file_id: id, base_version_id: id }),
  z.object({
    op: z.literal('move'),
    file_id: id,
    base_version_id: id,
    to_path: PathSchema,
  }),
  z.object({ op: z.literal('restore'), file_id: id, version_id: id }),
])
export type CommitOp = z.infer<typeof CommitOpSchema>

export const CommitRequestSchema = z.object({
  ops: z.array(CommitOpSchema).min(1).max(1000),
})
export type CommitRequest = z.infer<typeof CommitRequestSchema>

export const CommitOpResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    creation: z.enum(['novel', 'adopted', 'collision']).optional(),
    file_id: id,
    version_id: id,
    seq,
    path: PathSchema,
    /**
     * What the version this left as the head holds. It is what the op sent, except where the
     * server carried the head's own bytes across — a move over a head that had been edited
     * since the device's base — so a device records the sha of the version it now names
     * rather than the sha it happened to have on disk. Null for a delete.
     */
    sha: ShaSchema.nullable(),
    size: bytes,
    mtime,
  }),
  z.object({
    status: z.literal('merged'),
    creation: z.enum(['novel', 'adopted', 'collision']).optional(),
    file_id: id,
    version_id: id,
    seq,
    path: PathSchema,
    sha: ShaSchema,
    size: bytes,
    mtime,
  }),
  z.object({
    status: z.literal('conflict'),
    creation: z.enum(['novel', 'adopted', 'collision']).optional(),
    file_id: id,
    version_id: id,
    seq,
    path: PathSchema,
    /** The head that stayed at `path`, so the device can fetch it without waiting for the feed. */
    sha: ShaSchema,
    size: bytes,
    mtime,
    conflict_path: PathSchema,
    conflict_file_id: id,
    conflict_version_id: id,
  }),
  z.object({ status: z.literal('rejected'), code: ErrorCodeSchema, message: z.string() }),
])
export type CommitOpResult = z.infer<typeof CommitOpResultSchema>

export const CommitResponseSchema = z.object({
  head_seq: headSeq,
  results: z.array(CommitOpResultSchema),
  creation_outcomes: z
    .array(
      z
        .object({
          index: z.number().int().nonnegative(),
          kind: z.enum(['novel', 'adopted', 'collision']),
        })
        .strict()
    )
    .optional(),
})
export type CommitResponse = z.infer<typeof CommitResponseSchema>

/* ── History ────────────────────────────────────────────────────────────── */

/** How a merge version came about: what it merged, and whether it merged cleanly. */
export const MergeInfoSchema = z.object({
  base_version_id: id.nullable(),
  head_version_id: id,
  incoming_sha: ShaSchema,
  clean: z.boolean(),
})
export type MergeInfo = z.infer<typeof MergeInfoSchema>

export const VersionInfoSchema = z.object({
  version_id: id,
  no: z.number().int().positive(),
  seq,
  op: VersionOpSchema,
  path: PathSchema,
  sha: ShaSchema.nullable(),
  size: bytes,
  mtime,
  actor: ActorSchema,
  at: timestamp,
  merge: MergeInfoSchema.nullable(),
})
export type VersionInfo = z.infer<typeof VersionInfoSchema>

export const RestoreRequestSchema = z.object({ version_id: id })
export type RestoreRequest = z.infer<typeof RestoreRequestSchema>

export const TrashItemSchema = z.object({
  file_id: id,
  path: PathSchema,
  kind: FileKindSchema,
  deleted_at: timestamp,
  last_version_id: id,
  size: bytes,
  /**
   * Who committed the delete, so a confirmation can say which device emptied what. Null where
   * the delete's version cannot be read. Optional, so a server older than it still parses and
   * a host's own literals still type; absent means nobody is named.
   */
  deleted_by: ActorSchema.nullable().optional(),
})
export type TrashItem = z.infer<typeof TrashItemSchema>

/** The most files one bulk trash restore takes; a client sends more in several requests. */
export const TRASH_RESTORE_MAX = 1000

/**
 * Bring these files back from the trash in one commit. Each id once:
 * the answer is one result per id, in order, as a commit's are.
 */
export const TrashRestoreRequestSchema = z.object({
  file_ids: z
    .array(id)
    .min(1)
    .max(TRASH_RESTORE_MAX)
    .refine((ids) => new Set(ids).size === ids.length, 'each file id once'),
})
export type TrashRestoreRequest = z.infer<typeof TrashRestoreRequestSchema>

/* ── Uploads ────────────────────────────────────────────────────────────── */

export const UploadBeginRequestSchema = z.object({ size: z.number().int().positive() })
export type UploadBeginRequest = z.infer<typeof UploadBeginRequestSchema>

export const UploadBeginResponseSchema = z.object({
  upload_id: id,
  part_size: z.number().int().positive(),
  parts: z.number().int().positive(),
  received: z.array(z.number().int().nonnegative()).optional(),
})
export type UploadBeginResponse = z.infer<typeof UploadBeginResponseSchema>

/* ── Events ─────────────────────────────────────────────────────────────── */

/** What the event stream pushes: a new head sequence, or a scope epoch bump. */
export const EventFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('seq'), head_seq: headSeq }),
  z.object({ type: z.literal('scope_epoch'), epoch: headSeq }),
])
export type EventFrame = z.infer<typeof EventFrameSchema>

/** The first frame a client sends on the event stream. */
export const EventHelloSchema = z.object({ token: z.string() })
export type EventHello = z.infer<typeof EventHelloSchema>
