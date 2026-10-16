import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, open, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Mutex } from 'async-mutex'
import type { Kysely } from 'kysely'
import type { Database } from './db/schema.js'
import { z } from 'zod'

const Checkpoint = z.object({
  generation: z.string().uuid(),
  heads: z.record(z.object({ seq: z.number().nonnegative(), digest: z.string() })),
})
type Checkpoint = z.infer<typeof Checkpoint>
const mutexes = new Map<string, Mutex>()
function checkpointMutex(path: string): Mutex {
  const key = resolve(path)
  let mutex = mutexes.get(key)
  if (!mutex) mutexes.set(key, (mutex = new Mutex()))
  return mutex
}

async function saveCheckpoint(path: string, value: Checkpoint) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

/** After a legitimate removal commits, forget only missing vaults. Never advance other
 * heads or the generation here: that could mask a real rollback awaiting startup. */
export async function pruneRestoreCheckpoint(db: Kysely<Database>, path: string) {
  await checkpointMutex(path).runExclusive(async () => {
    let previous: Checkpoint
    try {
      previous = Checkpoint.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const ids = new Set(
      (await db.selectFrom('vault_seq').select('vault_id').execute()).map((v) => v.vault_id)
    )
    for (const id of Object.keys(previous.heads)) if (!ids.has(id)) delete previous.heads[id]
    await saveCheckpoint(path, previous)
  })
}

/** This file belongs to the running installation, outside restored DB/blob snapshots. */
export const generationPath = (blobDir: string) => `${resolve(blobDir)}.restore-head.json`

export async function bumpGeneration(db: Kysely<Database>): Promise<string> {
  const generation = randomUUID()
  await db
    .updateTable('restore_generation')
    .set({ generation })
    .where('id', '=', 1)
    .executeTakeFirstOrThrow()
  return generation
}

/** A response is not acknowledged until its head is durably recorded. One server process
 * owns this checkpoint; restoration and the operator bump require stopping that process. */
export async function restoreGeneration(db: Kysely<Database>, path: string, forceNew = false) {
  const mutex = checkpointMutex(path)
  const snapshot = async (): Promise<Checkpoint> => {
    const row = await db
      .selectFrom('restore_generation')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow()
    const heads: Checkpoint['heads'] = {}
    for (const head of await db
      .selectFrom('vault_seq')
      .select(['vault_id', 'head_seq'])
      .execute()) {
      const files = await db
        .selectFrom('versions')
        .select('id')
        .where('vault_id', '=', head.vault_id)
        .where('seq', '=', head.head_seq)
        .orderBy('id')
        .execute()
      const directories = await db
        .selectFrom('directories')
        .select(['id', 'version_id'])
        .where('space_id', '=', head.vault_id)
        .where('seq', '=', head.head_seq)
        .orderBy('id')
        .execute()
      heads[head.vault_id] = {
        seq: Number(head.head_seq),
        digest: createHash('sha256').update(JSON.stringify({ files, directories })).digest('hex'),
      }
    }
    return { generation: row.generation, heads }
  }
  const save = (value: Checkpoint) => saveCheckpoint(path, value)
  let previous: Checkpoint | undefined
  try {
    previous = Checkpoint.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let current = await snapshot()
  if (
    forceNew ||
    (previous &&
      (previous.generation !== current.generation ||
        Object.entries(previous.heads).some(([id, old]) => {
          const now = current.heads[id]
          return (
            now !== undefined &&
            (now.seq < old.seq || (now.seq === old.seq && now.digest !== old.digest))
          )
        })))
  ) {
    current.generation = await bumpGeneration(db)
  }
  await save(current)
  return {
    get generation() {
      return current.generation
    },
    checkpoint: () =>
      mutex.runExclusive(async () => {
        current = await snapshot()
        await save(current)
      }),
  }
}
