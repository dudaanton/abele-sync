import type { FileSystem } from './fs.js'
import { EngineError } from './errors.js'
export const stageMissing = (error: unknown) =>
  (error as { code?: string } | null)?.code === 'ENOENT'
export async function discardPullStage(fs: FileSystem, id: string): Promise<void> {
  try {
    if (fs.discardStage) await fs.discardStage(id)
    else if (fs.reopenStage) await (await fs.reopenStage(id)).discard()
    else throw new EngineError('io', 'host cannot discard a pending pull stage')
  } catch (error) {
    if (!stageMissing(error)) throw error
  }
}
