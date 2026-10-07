import { z } from 'zod'
import { PathSchema, ShaSchema } from './schemas.js'
const id = z.string().min(1).max(200),
  revision = z.number().int().nonnegative().safe()
/** Current admitted version only; an invisible target carries no version proof. */
export const TargetVisibilitySchema = z
  .object({
    grantId: id,
    label: z.string().min(1).max(200),
    targetFileId: id,
    visible: z.boolean(),
    targetVersionId: id.nullable(),
    scopeRevision: revision,
    revision,
    withdrawalGeneration: revision,
  })
  .strict()
  .refine((view) => view.visible === (view.targetVersionId !== null), {
    message: 'visible targets must name their admitted version',
  })
export type TargetVisibility = z.infer<typeof TargetVisibilitySchema>
export const AssetSponsorSchema = z
  .object({
    fileId: id,
    versionId: id,
    admissionGeneration: z.number().int().positive().safe(),
    inScope: z.literal(true),
    intrinsic: z.literal(true),
  })
  .strict()
export const IntrinsicSponsorProofSchema = z
  .object({ grantId: id, sponsor: AssetSponsorSchema })
  .strict()
export type IntrinsicSponsorProof = z.infer<typeof IntrinsicSponsorProofSchema>
export const AssetTargetSchema = z
  .object({
    fileId: id,
    versionId: id,
    sha: ShaSchema,
    path: PathSchema,
    eligible: z.literal(true),
  })
  .strict()
export const PublishedAssetSchema = z
  .object({
    target: AssetTargetSchema,
    sponsors: z.array(AssetSponsorSchema).min(1).max(64),
    reason: z.string().max(100),
    kind: z.enum(['owner-extra', 'native-asset']),
  })
  .strict()
export const AssetViewSchema = z
  .object({
    grantId: id,
    revision,
    withdrawalGeneration: revision,
    active: z.boolean(),
    role: z.enum(['reader', 'editor']),
    entries: z.array(PublishedAssetSchema).max(1000),
  })
  .strict()
export const OwnerAssetAddSchema = z
  .object({
    grantId: id,
    expectedRevision: revision,
    withdrawalGeneration: revision,
    intentId: id,
    decisionDeviceId: id,
    target: AssetTargetSchema,
    sponsors: z.array(AssetSponsorSchema).min(1).max(64),
    reason: z.enum(['initial-batch', 'new-local', 'confirmed-existing']),
  })
  .strict()
export const AssetMutationSchema = z
  .object({
    expectedRevision: revision,
    intentId: id,
    withdrawalGeneration: revision.optional(),
    decisionDeviceId: id.optional(),
    delta: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('add'),
          entry: PublishedAssetSchema.extend({
            kind: z.literal('owner-extra'),
            reason: z.enum(['initial-batch', 'new-local', 'confirmed-existing']),
          }),
        })
        .strict(),
      z
        .object({
          kind: z.literal('remove-sponsor'),
          sponsorId: id,
          withdrawWhenEmpty: z.literal(true),
        })
        .strict(),
      z.object({ kind: z.literal('withdraw'), fileId: id, expectedGeneration: revision }).strict(),
    ]),
  })
  .strict()
export const NativeSponsoredCreateSchema = z
  .object({
    grantId: id,
    path: PathSchema,
    localCreateHandle: id,
    sha: ShaSchema,
    eligible: z.literal(true),
    sponsor: AssetSponsorSchema,
    upload: z
      .object({
        principalId: id,
        grantId: id,
        sha: ShaSchema,
        entitlementId: z.string().min(1).max(4096),
      })
      .strict(),
  })
  .strict()
export type AssetView = z.infer<typeof AssetViewSchema>
