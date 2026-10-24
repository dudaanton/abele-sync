import { expect, it } from 'vitest'
import {
  UsageSchema,
  VaultSettingsPatchSchema,
  VaultSettingsSchema,
  VaultSettingsUpdateRequestSchema,
} from '../src/schemas.js'
import { V2ContentPreviewQuerySchema, V2CommitRequestSchema } from '../src/v2.js'
import { TargetVisibilitySchema } from '../src/sponsoredAssets.js'

it('keeps omitted settings patches absent, including nested retention fields', () => {
  expect(VaultSettingsPatchSchema.parse({})).toEqual({})
  expect(VaultSettingsUpdateRequestSchema.parse({ account_password: 'proof' })).toEqual({
    account_password: 'proof',
  })
  expect(VaultSettingsPatchSchema.parse({ retention: { notes_days: 7 } })).toEqual({
    retention: { notes_days: 7 },
  })
  expect(VaultSettingsSchema.parse({}).retention).toEqual({
    notes_days: 365,
    attachments_days: 14,
    settings_days: 30,
  })
  expect(VaultSettingsPatchSchema.safeParse({ retention: { notes_days: -1 } }).success).toBe(false)
})

it('keeps usage sparse while rejecting unknown enum keys and invalid values', () => {
  const base = { live_bytes: 0, history_bytes: 0, trash_bytes: 0, quota_bytes: null }
  for (const by_kind of [{}, { note: { live_bytes: 0, count: 0 } }])
    expect(UsageSchema.parse({ ...base, by_kind }).by_kind).toEqual(by_kind)
  for (const by_kind of [
    { unknown: { live_bytes: 0, count: 0 } },
    { note: { live_bytes: -1, count: 0 } },
  ])
    expect(UsageSchema.safeParse({ ...base, by_kind }).success).toBe(false)
})

it('retains bounded numeric coercion and strict request envelopes', () => {
  expect(V2ContentPreviewQuerySchema.parse({})).toEqual({ limit: 100 })
  expect(V2ContentPreviewQuerySchema.parse({ limit: '12' })).toEqual({ limit: 12 })
  for (const limit of ['', null, '1.5', '501', 'Infinity', 'no'])
    expect(V2ContentPreviewQuerySchema.safeParse({ limit }).success).toBe(false)
  expect(V2ContentPreviewQuerySchema.safeParse({ limit: 1, extra: true }).success).toBe(false)
  expect(
    V2CommitRequestSchema.safeParse({ ops: [{ op: 'mkdir', path: 'folder', extra: true }] }).success
  ).toBe(false)
  expect(
    V2CommitRequestSchema.safeParse({ ops: [{ op: 'unknown', path: 'folder' }] }).success
  ).toBe(false)
})

it('preserves cross-field refinements', () => {
  const view = {
    grantId: 'g',
    label: 'g',
    targetFileId: 'f',
    visible: true,
    targetVersionId: 'v',
    scopeRevision: 0,
    revision: 0,
    withdrawalGeneration: 0,
  }
  expect(TargetVisibilitySchema.parse(view)).toEqual(view)
  expect(TargetVisibilitySchema.safeParse({ ...view, targetVersionId: null }).success).toBe(false)
  expect(TargetVisibilitySchema.safeParse({ ...view, visible: false }).success).toBe(false)
})
