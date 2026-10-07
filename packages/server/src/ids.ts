import { randomUUID } from 'node:crypto'

/** A fresh identifier for a row we are about to insert. */
export const newId = (): string => randomUUID()

/** The current instant as an ISO-8601 string in UTC. */
export const nowIso = (): string => new Date().toISOString()
