/** Every failure the engine reports to its host. */
export type EngineErrorCode = 'offline' | 'unauthorized' | 'protocol' | 'conflict' | 'io' | 'lost'

/**
 * The one error type the engine throws. Hosts switch on `code`: `offline` retries later,
 * `unauthorized` asks for a token, `protocol` and `io` surface, `conflict` reconciles.
 * `lost` is the host's `stillHeld` saying no: the vault is not this process's any more, and
 * the run stops where it is. No step of the engine takes it for anything else, so none carries
 * on past it.
 */
export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

/** A non-envelope HTTP refusal keeps its transport status. It is still an
 * EngineError for existing callers, but negotiation must not infer unsupported
 * features merely from its generic protocol code (for example a proxy's 403).
 */
export class HttpError extends EngineError {
  constructor(
    readonly status: number,
    code: EngineErrorCode,
    message: string
  ) {
    super(code, message)
    this.name = 'HttpError'
  }
}
