/** Read a JSON text column. */
export const readJson = <T>(s: string): T => JSON.parse(s) as T

/** Write a value into a JSON text column. */
export const writeJson = (v: unknown): string => JSON.stringify(v)
