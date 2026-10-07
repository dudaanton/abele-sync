import { z } from 'zod'
import { newId } from '../../ids.js'
const id = z.string().min(1).max(200),
  key = z.string().min(1).max(1024)
const Writer = z
  .object({
    facet: z.enum(['device', 'scoped', 'unknown']),
    principalId: id.nullable(),
    accountId: id.nullable(),
    grantId: id.nullable(),
  })
  .strict()
export type GroupWriter = z.infer<typeof Writer>
const Origin = z
  .object({
    id,
    kind: z.enum(['owner_personal', 'grant_native', 'recipient', 'unknown']),
    versionId: id,
    writer: Writer,
    grantId: id.nullable(),
  })
  .strict()
export type GroupOrigin = z.infer<typeof Origin>
const Edge = z
  .object({
    origin: Origin,
    targetId: id.nullable(),
    bindingState: z.enum(['unresolved', 'bound', 'tombstoned']).optional(),
    removedByOwner: id.nullable(),
  })
  .strict()
export const GroupOriginStateSchema = z
  .object({
    memory: z.record(Edge),
    active: z.array(key).max(256),
    uncertain: z.boolean(),
    limited: z.boolean().optional(),
  })
  .strict()
export type GroupOriginState = z.infer<typeof GroupOriginStateSchema>
export type GroupEdge = z.infer<typeof Edge>
const Input = z
  .object({
    versionId: id,
    ownerAccountId: id,
    writer: Writer,
    operation: z.string().max(20),
    status: z.enum(['valid', 'invalid', 'unknown', 'limited']),
    tokens: z.array(z.object({ key, targetId: id.nullable() }).strict()).max(256),
    previous: GroupOriginStateSchema.optional(),
    sources: z.array(GroupOriginStateSchema).max(8).default([]),
    nativeRoot: z.object({ key, targetId: id, grantId: id }).strict().optional(),
    approvedKeys: z.array(key).max(256).default([]),
  })
  .strict()
/** Source attribution includes binding identity, including unresolved state.
 * Final actors, deletion, copy paths and format rewrites never upgrade it.
 */
export function reduceGroupOrigins(input: unknown): GroupOriginState {
  const body = Input.parse(input),
    previous = body.previous ?? { memory: {}, active: [], uncertain: false },
    memory: GroupOriginState['memory'] = Object.create(null)
  for (const [token, edge] of Object.entries(previous.memory)) memory[token] = structuredClone(edge)
  const owner =
    body.writer.facet === 'device' &&
    body.writer.principalId !== null &&
    body.writer.accountId === body.ownerAccountId
  const direct = body.operation === 'modify' || body.operation === 'create'
  const limited = (): GroupOriginState => {
    const bounded: GroupOriginState['memory'] = Object.create(null)
    let bytes = 0
    for (const [token, edge] of Object.entries(memory)) {
      bytes += Buffer.byteLength(JSON.stringify({ [token]: edge }))
      if (Object.keys(bounded).length >= 1000 || bytes > 512 * 1024) break
      bounded[token] = edge
    }
    return { memory: bounded, active: [], uncertain: true, limited: true }
  }
  if (
    previous.limited &&
    body.status === 'valid' &&
    body.operation === 'modify' &&
    owner &&
    body.tokens.length === 0
  ) {
    // Explicit complete owner removal establishes a fresh negative baseline.
    // Immutable database origins remain; an ordinary re-save cannot do this.
    return { memory: {}, active: [], uncertain: false }
  }
  if (Object.keys(memory).length > 1000) return limited()
  if (
    previous.limited &&
    !(body.status === 'valid' && body.operation === 'modify' && owner && body.tokens.length === 0)
  )
    return limited()
  if (body.status !== 'valid')
    return { memory, active: [], uncertain: true, ...(previous.limited ? { limited: true } : {}) }
  const tokens = new Set(body.tokens.map((token) => token.key)),
    active: string[] = []
  // Note deletion is not an explicit edit removing membership tokens.
  for (const [token, edge] of Object.entries(memory))
    if (
      !tokens.has(token) &&
      body.operation === 'modify' &&
      owner &&
      previous.active.includes(token)
    )
      edge.removedByOwner = body.versionId
  const make = (kind: GroupOrigin['kind']): GroupOrigin => ({
    id: newId(),
    kind,
    versionId: body.versionId,
    writer:
      kind === 'unknown'
        ? { facet: 'unknown', principalId: null, accountId: null, grantId: null }
        : body.writer,
    grantId: kind === 'recipient' || kind === 'grant_native' ? body.writer.grantId : null,
  })
  const matches = (
    state: GroupOriginState,
    token: { key: string; targetId: string | null },
    activeOnly: boolean
  ): GroupEdge[] => {
    const exact = state.memory[token.key]
    if (exact && (!activeOnly || state.active.includes(token.key))) return [exact]
    return token.targetId
      ? Object.entries(state.memory)
          .filter(
            ([key, edge]) =>
              edge.targetId === token.targetId && (!activeOnly || state.active.includes(key))
          )
          .map(([, edge]) => edge)
      : []
  }
  for (const token of body.tokens) {
    const old = matches(previous, token, false),
      inherited = body.sources.flatMap((source) => matches(source, token, true)),
      approved = owner && body.approvedKeys.includes(token.key)
    const prior = old[0],
      source = inherited[0]
    let origin: GroupOrigin, carrier: GroupEdge | undefined
    if (approved) origin = make('owner_personal')
    else if (prior?.removedByOwner) {
      // Standing owner withdrawal cannot be undone by a recipient or by an
      // inherited stale-base/restore token. Fresh owner addition requires a
      // clean negative base with no active source carrying that old token.
      origin =
        direct &&
        owner &&
        inherited.length === 0 &&
        body.sources.every((source) => !source.uncertain && !source.limited)
          ? make('owner_personal')
          : direct && body.writer.facet === 'scoped'
            ? make('recipient')
            : make('unknown')
      carrier = prior
    } else if (prior) {
      origin = old.every((edge) => edge.origin.id === prior.origin.id)
        ? prior.origin
        : make('unknown')
      carrier = prior
    } else if (source) {
      const scopedBirth =
        body.writer.facet === 'scoped' &&
        !body.previous &&
        (body.operation === 'create' || body.operation === 'conflict')
      origin = scopedBirth
        ? make('recipient')
        : inherited.every((edge) => edge.origin.id === source.origin.id)
          ? source.origin
          : make('unknown')
      // An ambiguous binding never guesses either target. Unresolved remains so.
      carrier = inherited.every(
        (edge) =>
          edge.targetId === source.targetId &&
          (edge.bindingState ?? (edge.targetId ? 'bound' : 'unresolved')) ===
            (source.bindingState ?? (source.targetId ? 'bound' : 'unresolved'))
      )
        ? source
        : { ...source, targetId: null, bindingState: 'unresolved' }
    } else if (
      !direct ||
      previous.uncertain ||
      body.sources.some((source) => source.uncertain || source.limited)
    )
      origin = make('unknown')
    else if (owner) origin = make('owner_personal')
    else if (body.writer.facet === 'scoped' && body.writer.principalId && body.writer.grantId)
      origin = make(
        body.operation === 'create' &&
          body.nativeRoot?.key === token.key &&
          body.nativeRoot.grantId === body.writer.grantId
          ? 'grant_native'
          : 'recipient'
      )
    else origin = make('unknown')
    memory[token.key] = {
      origin,
      targetId: carrier ? carrier.targetId : token.targetId,
      ...(carrier
        ? {
            bindingState:
              carrier.bindingState ??
              (carrier.targetId ? ('bound' as const) : ('unresolved' as const)),
          }
        : {}),
      removedByOwner: null,
    }
    active.push(token.key)
  }
  if (Object.keys(memory).length > 1000 || Buffer.byteLength(JSON.stringify(memory)) > 900 * 1024)
    return limited()
  const uncertain =
    previous.uncertain && !(body.operation === 'modify' && owner && tokens.size === 0)
  return { memory, active: [...new Set(active)], uncertain }
}
