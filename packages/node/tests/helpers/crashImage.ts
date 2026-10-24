/** Canonical metadata for comparison only; never used to restore an image. */
export function canonicalCrashMetadata(
  path: string,
  data: string,
  identities: ReadonlyMap<string, readonly string[]>,
  now: number
): string {
  const identityData = data.replace(
    /"identity":"(\d+:\d+:\d+)"/g,
    (_match, identity: string) =>
      `"identity":${JSON.stringify(identities.has(identity) ? [...identities.get(identity)!].sort() : 'retired')}`
  )
  if (!/(^|\/)\.abele-sync\/retained-removals\/summary\.json$/.test(path)) return identityData
  // Every passing crash-model test finishes within 120 seconds. Captures that
  // cannot reach the 24-hour reclamation boundary in that time have identical
  // age eligibility. Preserve exact values for older/future timestamps, including
  // byte-bound ordering and the seven-day boundary. Actual backup bytes stay raw.
  return identityData.replace(/"capturedAt":(\d+)(?=[,}])/g, (match, value: string) => {
    const age = now - Number(value)
    return age >= 0 && age < 86400000 - 120000 ? '"capturedAt":"protected"' : match
  })
}
/** Apply once to the complete image, preserving equality AND inequality of IDs. */
export function canonicalCrashIdentifiers(text: string): string {
  for (const [pattern, label] of [
    [/group-[a-zA-Z0-9]+/g, 'group-ID'],
    [/[a-f0-9]{8}-[a-f0-9-]{27,}/g, 'UUID'],
    [/[a-f0-9]{24,64}/g, 'HEX'],
  ] as const) {
    const symbols = new Map<string, string>()
    text = text.replace(pattern, (value) => {
      if (!symbols.has(value)) symbols.set(value, `${label}#${symbols.size}`)
      return symbols.get(value)!
    })
  }
  return text
}
