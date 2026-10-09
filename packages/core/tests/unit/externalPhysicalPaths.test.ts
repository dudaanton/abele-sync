import { describe, expect, it } from 'vitest'
import {
  decodeExternalDocument,
  ExternalOperationSchema,
  ExternalRecordSchema,
  OwnedArtifactSchema,
} from '../../src/index.js'

const binding = {
  endpoint: 'https://sync.example.invalid',
  vaultId: 'sample-vault',
  mode: 'personal' as const,
  principalId: 'sample-principal',
  principalType: 'device' as const,
  grantId: null,
  generation: 1,
  credentialAssociation: 'sample-slot',
}
const record = {
  schema: 1,
  ledgerId: 'sample-ledger',
  fileId: 'sample-file',
  binding,
  representation: 'remote-only',
  preference: 'on-demand',
  pinned: false,
  projectionPath: 'Media/sample.jpg.abele-ref',
  projectionSha: 'b'.repeat(64),
  localRevision: 0,
  pendingOperationId: null,
  availability: 'active',
  blockingReason: null,
  lastProvenLocalBase: null,
  retained: [],
}
const operation = {
  schema: 1,
  operationId: 'sample-operation',
  kind: 'eviction',
  phase: 'prepared',
  revision: 0,
  connectionGeneration: 1,
  expected: {
    fileId: record.fileId,
    versionId: 'sample-version',
    path: 'Media/sample.jpg',
    sha: 'a'.repeat(64),
    size: 10,
  },
  sourcePath: 'Media/sample.jpg',
  targetPath: record.projectionPath,
  previousRepresentation: 'hydrated',
  localBase: null,
  desiredRepresentation: 'remote-only',
  projectionDigest: record.projectionSha,
  ownedArtifacts: [],
  unresolvedOutcome: null,
  cleanupReason: null,
}
const bytes = (path: string) => new TextEncoder().encode(path).byteLength
const artifact = (path: string) => ({
  path,
  sha: 'a'.repeat(64),
  size: 10,
  role: 'projection',
  operationId: operation.operationId,
})

describe('raw physical UTF-8 bounds in canonical external state', () => {
  // Mirrored from plugin commit 13b6e8d6: normalization cannot make a physical
  // filename fit a filesystem component limit that its actual spelling exceeds.
  it('BUG: rejects an overlong physical spelling in the canonical external record schema, not just its NFC form', () => {
    const physical = 'Media/' + 'e\u0301'.repeat(90) + '.jpg.abele-ref'
    expect(bytes(physical.split('/').at(-1)!)).toBe(284)
    expect(bytes(physical.normalize('NFC').split('/').at(-1)!)).toBe(194)
    expect(ExternalRecordSchema.safeParse({ ...record, projectionPath: physical }).success).toBe(
      false
    )
    expect(
      ExternalRecordSchema.safeParse({ ...record, projectionPath: physical.normalize('NFC') })
        .success
    ).toBe(true)
  })

  for (const [name, physical] of [
    ['filename', 'Media/' + 'e\u0301'.repeat(90) + '.jpg.abele-ref'],
    ['parent component', 'e\u0301'.repeat(90) + '/sample.jpg.abele-ref'],
    ['whole path', Array(5).fill('e\u0301'.repeat(70)).join('/') + '/a.jpg.abele-ref'],
  ] as const) {
    it(`BUG: raw ${name} bounds also reject operation locations and owned projection artifacts`, () => {
      expect(ExternalRecordSchema.safeParse({ ...record, projectionPath: physical }).success).toBe(
        false
      )
      for (const field of ['sourcePath', 'targetPath'])
        expect(ExternalOperationSchema.safeParse({ ...operation, [field]: physical }).success).toBe(
          false
        )
      expect(OwnedArtifactSchema.safeParse(artifact(physical)).success).toBe(false)
      expect(
        ExternalRecordSchema.safeParse({ ...record, retained: [artifact(physical)] }).success
      ).toBe(false)
      expect(
        ExternalRecordSchema.safeParse({ ...record, projectionPath: physical.normalize('NFC') })
          .success
      ).toBe(true)
    })
  }

  it('BUG: reopening overlong persisted projection paths establishes a recovery hold', () => {
    const physical = 'Media/' + 'e\u0301'.repeat(90) + '.jpg.abele-ref'
    const raw = JSON.stringify({
      schema: 1,
      ledgerId: record.ledgerId,
      binding,
      revision: 0,
      files: [{ ...record, projectionPath: physical }],
      operations: [],
    })
    expect(() => decodeExternalDocument(raw)).toThrowError(
      expect.objectContaining({ reason: 'recovery-required' })
    )
  })

  it('preserves bounded decomposed physical spelling instead of normalizing the stored path', () => {
    const physical = 'Media/cafe\u0301.jpg.abele-ref'
    expect(ExternalRecordSchema.parse({ ...record, projectionPath: physical }).projectionPath).toBe(
      physical
    )
    expect(OwnedArtifactSchema.parse(artifact('Media/.cafe\u0301.tmp')).path).toBe(
      'Media/.cafe\u0301.tmp'
    )
  })

  it('BUG: applies the same raw byte limits to hidden recovery components before their validation substitution', () => {
    const physical = 'Media/.' + 'e\u0301'.repeat(90) + '.tmp'
    expect(OwnedArtifactSchema.safeParse(artifact(physical)).success).toBe(false)
    expect(OwnedArtifactSchema.safeParse(artifact(physical.normalize('NFC'))).success).toBe(true)
  })

  it('BUG: accepts 255-byte components but refuses the next physical byte', () => {
    const physical = 'Media/' + 'e\u0301'.repeat(80) + 'x.jpg.abele-ref'
    expect(bytes(physical.split('/').at(-1)!)).toBe(255)
    expect(ExternalRecordSchema.safeParse({ ...record, projectionPath: physical }).success).toBe(
      true
    )
    expect(
      ExternalRecordSchema.safeParse({ ...record, projectionPath: physical + 'x' }).success
    ).toBe(false)
  })

  it('accepts a 1024-byte physical path and refuses 1025 bytes with individually valid components', () => {
    const physical = [
      'a'.repeat(255),
      'b'.repeat(255),
      'c'.repeat(255),
      'd'.repeat(240),
      'a.jpg.abele-ref',
    ].join('/')
    expect(bytes(physical)).toBe(1024)
    expect(ExternalRecordSchema.safeParse({ ...record, projectionPath: physical }).success).toBe(
      true
    )
    expect(
      ExternalRecordSchema.safeParse({ ...record, projectionPath: physical + 'x' }).success
    ).toBe(false)
  })
})
