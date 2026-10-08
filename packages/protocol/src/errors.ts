/** Every error code the wire protocol can carry; also used to build its zod enum. */
export const ERROR_CODES = [
  'unauthorized',
  'account_password_required',
  'forbidden',
  'scoped_unavailable',
  'external_files_unavailable',
  'unsupported_scoped_protocol',
  'scope_updating',
  'scope_unavailable',
  'not_found',
  'invalid_path',
  'path_taken',
  'case_collision',
  'too_large',
  'quota_exceeded',
  'quota_waiting',
  'hash_mismatch',
  'stale_base',
  'leaves_scope',
  'unreferenced_attachment',
  'shared_attachment',
  'referenced_outside_scope',
  'scripts_forbidden',
  'settings_forbidden',
  'tx_expired',
  'tx_conflict',
  'rate_limited',
  'idempotency_mismatch',
  'invalid_request',
  'conflict',
  'internal',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** The HTTP status each code answers with. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  account_password_required: 403,
  forbidden: 403,
  scoped_unavailable: 503,
  external_files_unavailable: 503,
  unsupported_scoped_protocol: 400,
  scope_updating: 503,
  scope_unavailable: 503,
  not_found: 404,
  invalid_path: 400,
  path_taken: 409,
  case_collision: 409,
  too_large: 413,
  quota_exceeded: 413,
  /**
   * The vault's uncommitted uploads leave no room for this one now; they are committed or given
   * up on in time, so unlike `quota_exceeded` it is worth asking again later.
   */
  quota_waiting: 409,
  hash_mismatch: 400,
  stale_base: 412,
  leaves_scope: 403,
  unreferenced_attachment: 409,
  shared_attachment: 409,
  referenced_outside_scope: 409,
  scripts_forbidden: 403,
  settings_forbidden: 403,
  tx_expired: 410,
  tx_conflict: 409,
  rate_limited: 429,
  idempotency_mismatch: 422,
  invalid_request: 400,
  conflict: 409,
  internal: 500,
}

/** The error envelope every failing response sends. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> }
}

export class AbeleError extends Error {
  readonly status: number

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'AbeleError'
    this.status = ERROR_STATUS[code]
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } }
  }
}
