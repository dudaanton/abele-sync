/** Bytes are not identity evidence. A saved action owns both its unchanged
 * source baseline and a destination that is free or still that same baseline.
 * Call with freshly resolved destination spelling, inside the settlement tx. */
type Identity = { fileId: string; versionId: string }
export function replayAuthority(
  fileId: string,
  expected: Identity | null,
  current: Identity | null,
  occupant: Identity | null
): boolean {
  const unchanged =
    expected === null
      ? current === null
      : current?.fileId === fileId &&
        expected.fileId === fileId &&
        current.versionId === expected.versionId
  return (
    unchanged &&
    (occupant === null ||
      (occupant.fileId === fileId && occupant.versionId === expected?.versionId))
  )
}
