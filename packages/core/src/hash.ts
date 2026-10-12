import { sha256 as incrementalSha256 } from '@noble/hashes/sha256'
const ENCODER = new TextEncoder()

/** UTF-8 bytes of a string, through the global `TextEncoder`. */
export const encodeText = (s: string): Uint8Array => ENCODER.encode(s)

/**
 * SHA-256 as lowercase hex without a whole-input WebCrypto snapshot.
 */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = incrementalSha256.create()
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
    hash.update(bytes.subarray(offset, offset + 1024 * 1024))
  const digest = hash.digest()
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}
