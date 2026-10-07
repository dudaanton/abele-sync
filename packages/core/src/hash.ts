const ENCODER = new TextEncoder()

/** UTF-8 bytes of a string, through the global `TextEncoder`. */
export const encodeText = (s: string): Uint8Array => ENCODER.encode(s)

/**
 * SHA-256 as lowercase hex, through WebCrypto — the one digest the protocol speaks.
 * `crypto.subtle` is global in Obsidian (desktop and mobile) and in Node 22.
 */
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Node's WebCrypto types want an ArrayBuffer-backed view; every Uint8Array we hash is one,
  // its type just says `ArrayBufferLike`. Assert rather than copy the whole file.
  const data = bytes as Uint8Array<ArrayBuffer>
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}
