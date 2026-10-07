import { expect, it } from 'vitest'
import { TargetVisibilitySchema } from '../src/sponsoredAssets.js'

const view = {
  grantId: 'g',
  label: 'Audience',
  targetFileId: 'f',
  visible: true,
  targetVersionId: 'v',
  scopeRevision: 1,
  revision: 0,
  withdrawalGeneration: 0,
}
it('validates a strict point visibility response', () => {
  expect(TargetVisibilitySchema.parse(view)).toEqual(view)
  expect(
    TargetVisibilitySchema.parse({ ...view, visible: false, targetVersionId: null })
  ).toMatchObject({ visible: false })
  for (const invalid of [
    { ...view, unexpected: true },
    { ...view, grantId: '' },
    { ...view, label: '' },
    { ...view, visible: 'true' },
    { ...view, targetVersionId: '' },
    { ...view, scopeRevision: -1 },
    { ...view, revision: 0.5 },
    { ...view, withdrawalGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...view, visible: true, targetVersionId: null },
    { ...view, visible: false, targetVersionId: 'v' },
  ])
    expect(TargetVisibilitySchema.safeParse(invalid).success).toBe(false)
})
