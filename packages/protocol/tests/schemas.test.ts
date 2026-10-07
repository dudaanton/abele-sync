import { describe, it, expect } from 'vitest'
import {
  CommitRequestSchema,
  VaultSettingsSchema,
  ChangeItemSchema,
  CommitOpResultSchema,
  LoginResponseSchema,
  EnrolDeviceResponseSchema,
  DeviceInfoSchema,
  EnrolDeviceRequestSchema,
  EnrolSiblingRequestSchema,
  UsageSchema,
  VaultInfoSchema,
  VaultStateSchema,
  ManifestResponseSchema,
  ChangesResponseSchema,
  CommitResponseSchema,
  VersionInfoSchema,
  TrashItemSchema,
  TrashRestoreRequestSchema,
  TRASH_RESTORE_MAX,
  UploadBeginRequestSchema,
  UploadBeginResponseSchema,
  EventFrameSchema,
  EventHelloSchema,
  type Actor,
  type ChangeItem,
  type ManifestItem,
  type Usage,
} from '../src/schemas.js'

const ts = new Date().toISOString()
const sha = 'a'.repeat(64)
const actor: Actor = { kind: 'device', id: 'd1', name: 'Laptop' }
const usage: Usage = {
  live_bytes: 10,
  history_bytes: 4,
  trash_bytes: 1,
  quota_bytes: null,
  by_kind: {},
}
const manifestItem: ManifestItem = {
  file_id: 'f1',
  path: 'a.md',
  kind: 'note',
  version_id: 'v1',
  seq: 1,
  sha,
  size: 3,
  mtime: 1_700_000_000_000,
}
const changeItem: ChangeItem = {
  seq: 1,
  file_id: 'f1',
  op: 'create',
  path: 'a.md',
  prev_path: null,
  sha,
  size: 3,
  mtime: 1_700_000_000_000,
  version_id: 'v1',
  kind: 'note',
  actor,
  at: ts,
}

describe('CommitRequestSchema', () => {
  it('accepts each op shape', () => {
    const r = CommitRequestSchema.parse({
      ops: [
        { op: 'create', path: 'a.md', sha: 'a'.repeat(64), size: 1, mtime: 1 },
        {
          op: 'modify',
          file_id: 'f',
          base_version_id: 'v',
          sha: 'b'.repeat(64),
          size: 1,
          mtime: 1,
        },
        { op: 'delete', file_id: 'f', base_version_id: 'v' },
        { op: 'move', file_id: 'f', base_version_id: 'v', to_path: 'b.md' },
        { op: 'restore', file_id: 'f', version_id: 'v0' },
      ],
    })
    expect(r.ops).toHaveLength(5)
  })
  it('rejects a sha that is not 64 lowercase hex chars', () => {
    expect(() =>
      CommitRequestSchema.parse({
        ops: [{ op: 'create', path: 'a.md', sha: 'XYZ', size: 1, mtime: 1 }],
      })
    ).toThrow()
  })
  it('rejects an empty batch and more than 1000 ops', () => {
    expect(() => CommitRequestSchema.parse({ ops: [] })).toThrow()
    const ops = Array.from({ length: 1001 }, (_, i) => ({
      op: 'delete',
      file_id: `f${i}`,
      base_version_id: 'v',
    }))
    expect(() => CommitRequestSchema.parse({ ops })).toThrow()
  })
  it('carries a create prefer of mine or theirs, and leaves it out when absent', () => {
    const create = { op: 'create', path: 'a.md', sha: 'a'.repeat(64), size: 1, mtime: 1 }
    for (const prefer of ['mine', 'theirs'] as const) {
      const r = CommitRequestSchema.parse({ ops: [{ ...create, prefer }] })
      expect(r.ops[0]).toEqual({ ...create, prefer })
    }
    expect(CommitRequestSchema.parse({ ops: [create] }).ops[0]).not.toHaveProperty('prefer')
    expect(() => CommitRequestSchema.parse({ ops: [{ ...create, prefer: 'merge' }] })).toThrow()
    expect(() => CommitRequestSchema.parse({ ops: [{ ...create, prefer: null }] })).toThrow()
  })
  it('keeps prefer to creates: a modify carrying one is read without it', () => {
    const modify = {
      op: 'modify',
      file_id: 'f',
      base_version_id: 'v',
      sha: 'a'.repeat(64),
      size: 1,
      mtime: 1,
    }
    const r = CommitRequestSchema.parse({ ops: [{ ...modify, prefer: 'mine' }] })
    expect(r.ops[0]).not.toHaveProperty('prefer')
  })
  it('rejects negative sizes and non-integer mtimes', () => {
    expect(() =>
      CommitRequestSchema.parse({
        ops: [{ op: 'create', path: 'a.md', sha: 'a'.repeat(64), size: -1, mtime: 1 }],
      })
    ).toThrow()
    expect(() =>
      CommitRequestSchema.parse({
        ops: [{ op: 'create', path: 'a.md', sha: 'a'.repeat(64), size: 1, mtime: 1.5 }],
      })
    ).toThrow()
  })
})

describe('VaultSettingsSchema', () => {
  it('fills defaults', () => {
    const s = VaultSettingsSchema.parse({})
    expect(s.conflict).toBe('merge')
    expect(s.max_file_bytes).toBe(200 * 1024 * 1024)
    expect(s.retention).toEqual({ notes_days: 365, attachments_days: 14, settings_days: 30 })
    expect(s.scripts_folder).toBe('Scripts')
    expect(s.key_signature).toBeNull()
    expect(s.quota_bytes).toBeNull()
  })
})

describe('ChangeItemSchema', () => {
  it('requires actor and kind', () => {
    expect(() =>
      ChangeItemSchema.parse({
        seq: 1,
        file_id: 'f',
        op: 'create',
        path: 'a.md',
        prev_path: null,
        sha: null,
        size: null,
        mtime: null,
        version_id: 'v',
        at: new Date().toISOString(),
      })
    ).toThrow()
  })
})

describe('CommitOpResultSchema', () => {
  it('discriminates on status', () => {
    expect(
      CommitOpResultSchema.parse({ status: 'rejected', code: 'not_found', message: 'x' }).status
    ).toBe('rejected')
    expect(() => CommitOpResultSchema.parse({ status: 'applied' })).toThrow()
  })
})

describe('account and device responses', () => {
  it('parses a login response', () => {
    expect(LoginResponseSchema.parse({ account_token: 'tok', expires_at: ts })).toEqual({
      account_token: 'tok',
      expires_at: ts,
    })
  })
  it('parses an enrolment response', () => {
    expect(
      EnrolDeviceResponseSchema.parse({ device_id: 'd1', device_token: 'dtok' }).device_id
    ).toBe('d1')
  })
  it('parses a device that has never been seen and one that has', () => {
    const base = {
      id: 'd1',
      name: 'Laptop',
      platform: 'desktop',
      vault_id: 'vault1',
      created_at: ts,
    }
    expect(DeviceInfoSchema.parse({ ...base, last_seen_at: null }).last_seen_at).toBeNull()
    expect(DeviceInfoSchema.parse({ ...base, last_seen_at: ts }).last_seen_at).toBe(ts)
  })
  it('reads which device enrolled a device, and none when an older server leaves it out', () => {
    const base = {
      id: 'd2',
      name: 'Phone',
      platform: 'mobile',
      vault_id: 'vault1',
      last_seen_at: null,
      created_at: ts,
    }
    expect(DeviceInfoSchema.parse({ ...base, enrolled_by: 'd1' }).enrolled_by).toBe('d1')
    expect(DeviceInfoSchema.parse({ ...base, enrolled_by: null }).enrolled_by).toBeNull()
    expect(DeviceInfoSchema.parse(base).enrolled_by).toBeNull()
  })
  it('parses a sibling request, and refuses one without a name or with an unknown platform', () => {
    expect(EnrolSiblingRequestSchema.parse({ name: 'Phone', platform: 'mobile' })).toEqual({
      name: 'Phone',
      platform: 'mobile',
    })
    expect(() => EnrolSiblingRequestSchema.parse({ name: '', platform: 'mobile' })).toThrow()
    expect(() => EnrolSiblingRequestSchema.parse({ name: 'x', platform: 'toaster' })).toThrow()
  })
  it('caps a device name at 200 characters, on both enrolment requests', () => {
    const at = 'n'.repeat(200)
    const over = 'n'.repeat(201)
    expect(EnrolSiblingRequestSchema.parse({ name: at, platform: 'mobile' }).name).toBe(at)
    expect(() => EnrolSiblingRequestSchema.parse({ name: over, platform: 'mobile' })).toThrow()
    const vault_id = 'v1'
    expect(EnrolDeviceRequestSchema.parse({ vault_id, name: at, platform: 'desktop' }).name).toBe(
      at
    )
    expect(() =>
      EnrolDeviceRequestSchema.parse({ vault_id, name: over, platform: 'desktop' })
    ).toThrow()
  })
  it('rejects a device whose last_seen_at is absent rather than null', () => {
    expect(() =>
      DeviceInfoSchema.parse({
        id: 'd1',
        name: 'Laptop',
        platform: 'desktop',
        vault_id: 'vault1',
        created_at: ts,
      })
    ).toThrow()
  })
})

describe('vault responses', () => {
  it('parses usage with no kinds and with one', () => {
    expect(UsageSchema.parse(usage).by_kind).toEqual({})
    const oneKind = UsageSchema.parse({ ...usage, by_kind: { note: { live_bytes: 10, count: 2 } } })
    expect(oneKind.by_kind.note).toEqual({ live_bytes: 10, count: 2 })
    expect(oneKind.by_kind.attachment).toBeUndefined()
  })
  it('rejects a by_kind key that is not a file kind', () => {
    expect(() =>
      UsageSchema.parse({ ...usage, by_kind: { bogus: { live_bytes: 1, count: 1 } } })
    ).toThrow()
  })
  it('parses vault info', () => {
    const v = VaultInfoSchema.parse({ id: 'vault1', name: 'Notes', role: 'owner', usage })
    expect(v.role).toBe('owner')
    expect(v.usage.quota_bytes).toBeNull()
  })
  it('parses vault state, defaults and all', () => {
    const state = VaultStateSchema.parse({ head_seq: 7, settings: {}, usage })
    expect(state.head_seq).toBe(7)
    expect(state.settings.scripts_folder).toBe('Scripts')
    expect(state.settings.retention.attachments_days).toBe(14)
  })
})

describe('ManifestResponseSchema', () => {
  it('parses a last page and a page with a cursor', () => {
    expect(
      ManifestResponseSchema.parse({ items: [manifestItem], next: null, head_seq: 1 }).next
    ).toBeNull()
    const page = ManifestResponseSchema.parse({
      items: [manifestItem],
      next: 'cursor-2',
      head_seq: 9,
    })
    expect(page.next).toBe('cursor-2')
    expect(page.items[0]?.kind).toBe('note')
  })
  it('rejects an item whose sha is not a hash', () => {
    expect(() =>
      ManifestResponseSchema.parse({
        items: [{ ...manifestItem, sha: 'nope' }],
        next: null,
        head_seq: 1,
      })
    ).toThrow()
  })
})

describe('ChangeItemSchema', () => {
  it('parses a fully populated change', () => {
    const c = ChangeItemSchema.parse(changeItem)
    expect(c).toEqual(changeItem)
  })
  it('parses a delete with every nullable field null', () => {
    const c = ChangeItemSchema.parse({
      ...changeItem,
      op: 'delete',
      prev_path: null,
      sha: null,
      size: null,
      mtime: null,
    })
    expect(c.sha).toBeNull()
    expect(c.size).toBeNull()
    expect(c.mtime).toBeNull()
  })
  it('parses a move that carries its previous path', () => {
    expect(
      ChangeItemSchema.parse({ ...changeItem, op: 'move', prev_path: 'old.md' }).prev_path
    ).toBe('old.md')
  })
  it('rejects a change whose prev_path is absent rather than null', () => {
    const { prev_path: _omitted, ...withoutPrevPath } = changeItem
    expect(() => ChangeItemSchema.parse(withoutPrevPath)).toThrow()
  })
})

describe('ChangesResponseSchema', () => {
  it('parses a page of changes', () => {
    const r = ChangesResponseSchema.parse({ items: [changeItem], head_seq: 1, next_since: 1 })
    expect(r.items).toHaveLength(1)
    expect(r.next_since).toBe(1)
  })
  it('parses an empty page at sequence zero', () => {
    expect(ChangesResponseSchema.parse({ items: [], head_seq: 0, next_since: 0 }).items).toEqual([])
  })
})

describe('CommitOpResultSchema', () => {
  it('parses an applied result, with the version it left as the head', () => {
    const applied = {
      status: 'applied',
      file_id: 'f1',
      version_id: 'v2',
      seq: 4,
      path: 'a.md',
      sha,
      size: 12,
      mtime: 1_700_000_000_000,
    }
    expect(CommitOpResultSchema.parse(applied)).toEqual(applied)
  })
  it('parses an applied delete, which left no bytes behind', () => {
    const deleted = {
      status: 'applied',
      file_id: 'f1',
      version_id: 'v3',
      seq: 5,
      path: 'a.md',
      sha: null,
      size: 0,
      mtime: 0,
    }
    expect(CommitOpResultSchema.parse(deleted)).toEqual(deleted)
  })
  it('refuses an applied result that does not say what the head now holds', () => {
    expect(() =>
      CommitOpResultSchema.parse({
        status: 'applied',
        file_id: 'f1',
        version_id: 'v2',
        seq: 4,
        path: 'a.md',
      })
    ).toThrow()
  })
  it('parses a merged result', () => {
    const r = CommitOpResultSchema.parse({
      status: 'merged',
      file_id: 'f1',
      version_id: 'v3',
      seq: 5,
      path: 'a.md',
      sha,
      size: 12,
      mtime: 1_700_000_000_000,
    })
    expect(r.status === 'merged' && r.sha).toBe(sha)
  })
  it('parses a conflict result', () => {
    const r = CommitOpResultSchema.parse({
      status: 'conflict',
      file_id: 'f1',
      version_id: 'v4',
      seq: 6,
      path: 'a.md',
      sha,
      size: 12,
      mtime: 1_700_000_000_000,
      conflict_path: 'a (conflict).md',
      conflict_file_id: 'f2',
      conflict_version_id: 'v5',
    })
    expect(r.status === 'conflict' && r.conflict_path).toBe('a (conflict).md')
  })
  it('parses a rejected result carrying an error code', () => {
    const r = CommitOpResultSchema.parse({
      status: 'rejected',
      code: 'stale_base',
      message: 'moved on',
    })
    expect(r.status === 'rejected' && r.code).toBe('stale_base')
  })
  it('rejects a code that is not an error code', () => {
    expect(() =>
      CommitOpResultSchema.parse({ status: 'rejected', code: 'made_up', message: 'x' })
    ).toThrow()
  })
})

describe('CommitResponseSchema', () => {
  it('parses a batch of results', () => {
    const r = CommitResponseSchema.parse({
      head_seq: 6,
      results: [
        {
          status: 'applied',
          file_id: 'f1',
          version_id: 'v2',
          seq: 5,
          path: 'a.md',
          sha,
          size: 12,
          mtime: 1,
        },
        { status: 'rejected', code: 'not_found', message: 'gone' },
      ],
    })
    expect(r.results).toHaveLength(2)
    expect(r.head_seq).toBe(6)
  })
})

describe('VersionInfoSchema', () => {
  const version = {
    version_id: 'v2',
    no: 2,
    seq: 3,
    op: 'modify',
    path: 'a.md',
    sha,
    size: 12,
    mtime: 1_700_000_000_000,
    actor,
    at: ts,
  }
  it('parses a version with no merge', () => {
    expect(VersionInfoSchema.parse({ ...version, merge: null }).merge).toBeNull()
  })
  it('parses a merged version', () => {
    const merge = {
      base_version_id: 'v0',
      head_version_id: 'v1',
      incoming_sha: 'b'.repeat(64),
      clean: true,
    }
    expect(VersionInfoSchema.parse({ ...version, op: 'merge', merge }).merge).toEqual(merge)
  })
  it('parses a merge whose base is unknown', () => {
    const merge = {
      base_version_id: null,
      head_version_id: 'v1',
      incoming_sha: 'b'.repeat(64),
      clean: false,
    }
    expect(
      VersionInfoSchema.parse({ ...version, op: 'merge', merge }).merge?.base_version_id
    ).toBeNull()
  })
  it('parses a delete, whose sha is null', () => {
    expect(
      VersionInfoSchema.parse({ ...version, op: 'delete', sha: null, merge: null }).sha
    ).toBeNull()
  })
  it('rejects a version whose merge is absent rather than null', () => {
    expect(() => VersionInfoSchema.parse(version)).toThrow()
  })
})

describe('TrashItemSchema', () => {
  it('parses a trashed file', () => {
    const t = TrashItemSchema.parse({
      file_id: 'f1',
      path: 'a.md',
      kind: 'note',
      deleted_at: ts,
      last_version_id: 'v9',
      size: 3,
    })
    expect(t.kind).toBe('note')
    expect(t.deleted_at).toBe(ts)
    // A server older than `deleted_by` does not say; that reads as nobody named.
    expect(t.deleted_by ?? null).toBeNull()
  })

  it('names who deleted it', () => {
    const actor = { kind: 'device', id: 'd1', name: 'MacBook' } as const
    const t = TrashItemSchema.parse({
      file_id: 'f1',
      path: 'a.md',
      kind: 'note',
      deleted_at: ts,
      last_version_id: 'v9',
      size: 3,
      deleted_by: actor,
    })
    expect(t.deleted_by).toEqual(actor)
  })
})

describe('TrashRestoreRequestSchema', () => {
  it('takes 1 to 1000 ids, each once', () => {
    expect(TrashRestoreRequestSchema.parse({ file_ids: ['a', 'b'] }).file_ids).toEqual(['a', 'b'])
    const ids = (n: number) => Array.from({ length: n }, (_, k) => `f${k}`)
    expect(TrashRestoreRequestSchema.safeParse({ file_ids: ids(TRASH_RESTORE_MAX) }).success).toBe(
      true
    )
    expect(TrashRestoreRequestSchema.safeParse({ file_ids: ids(1001) }).success).toBe(false)
    expect(TrashRestoreRequestSchema.safeParse({ file_ids: [] }).success).toBe(false)
    expect(TrashRestoreRequestSchema.safeParse({ file_ids: ['a', 'a'] }).success).toBe(false)
  })
})

describe('upload schemas', () => {
  it('parses a begin request and its response', () => {
    expect(UploadBeginRequestSchema.parse({ size: 5_000_000 }).size).toBe(5_000_000)
    const r = UploadBeginResponseSchema.parse({ upload_id: 'u1', part_size: 5_242_880, parts: 2 })
    expect(r).toEqual({ upload_id: 'u1', part_size: 5_242_880, parts: 2 })
  })
  it('rejects a zero-byte upload, which goes through the simple PUT', () => {
    expect(() => UploadBeginRequestSchema.parse({ size: 0 })).toThrow()
  })
})

describe('event schemas', () => {
  it('parses both frames and a hello', () => {
    expect(EventFrameSchema.parse({ type: 'seq', head_seq: 12 })).toEqual({
      type: 'seq',
      head_seq: 12,
    })
    expect(EventFrameSchema.parse({ type: 'scope_epoch', epoch: 3 })).toEqual({
      type: 'scope_epoch',
      epoch: 3,
    })
    expect(EventHelloSchema.parse({ token: 'tok' }).token).toBe('tok')
  })
  it('rejects a frame that is missing its payload', () => {
    expect(() => EventFrameSchema.parse({ type: 'seq' })).toThrow()
  })
})

describe('identifiers', () => {
  it('rejects an empty file_id in a modify op', () => {
    expect(() =>
      CommitRequestSchema.parse({
        ops: [{ op: 'modify', file_id: '', base_version_id: 'v', sha, size: 1, mtime: 1 }],
      })
    ).toThrow()
  })
})
