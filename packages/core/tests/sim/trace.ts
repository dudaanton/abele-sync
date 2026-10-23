import { writeFile, mkdir } from 'node:fs/promises'
import { V2SyncClient } from '@abele/sync-server/tests/helpers/v2SyncClient.js'
import { SimScheduler } from './scheduler.js'
import { simServer } from './server.js'
import { SimDevice } from './simDevice.js'
import { stages, idle, ledger, ownDownloads, haltedEffects } from './invariants.js'
import type { Trace } from './actions.js'
import { EngineError } from '../../src/errors.js'
import { SyncCancelled } from '../../src/engine.js'
import { converged } from './model.js'

export async function replay(trace: Trace) {
  const scheduler = new SimScheduler(trace.seed),
    server = await simServer(scheduler)
  let device = new SimDevice(scheduler, server.token, server.fetch)
  const owner = new V2SyncClient(server.token, server.fetch)
  const deleted = new Set<string>()
  try {
    for (const action of trace.actions) {
      switch (action.kind) {
        case 'sameSha': {
          const entry = await device.state.get(action.path)
          if (!entry) throw new Error('sameSha requires synced file')
          await owner.commit([
            {
              op: 'modify',
              file_id: entry.fileId,
              base_version_id: entry.versionId,
              sha: entry.sha,
              size: entry.size,
              mtime: scheduler.now(),
            },
          ])
          const before = device.network.downloads.length
          await device.quiesce()
          ownDownloads(device, before)
          break
        }
        case 'pausePull':
        case 'stopPull': {
          let mark = -1,
            stopping: Promise<void> | undefined
          scheduler.hook = async (point) => {
            if (
              mark < 0 &&
              point.startsWith(
                action.kind === 'pausePull' ? 'fs.conditionalFile#' : 'net.after.GET./v2/manifest#'
              )
            ) {
              mark = scheduler.points.length - 1
              if (action.kind === 'pausePull') device.engine.pause()
              else stopping = device.engine.stop()
            }
          }
          try {
            try {
              await device.engine.sync()
            } catch (error) {
              if (!(error instanceof SyncCancelled)) throw error
            }
            await stopping
            if (mark < 0) throw new Error('pull mark not reached')
            haltedEffects(
              scheduler.points
                .slice(mark + 1)
                .filter((p) => /^fs\.(stage.commit|conditionalFile)#/.test(p)).length,
              4
            )
          } finally {
            scheduler.hook = undefined
          }
          break
        }
        case 'write':
          deleted.delete(action.path)
          await device.write(action.path, action.text)
          break
        case 'append': {
          const before = device.fs.snapshot().get(action.path) ?? new Uint8Array()
          await device.write(action.path, new TextDecoder().decode(before) + action.text)
          break
        }
        case 'delete':
          deleted.add(action.path)
          await device.fs.remove(action.path)
          break
        case 'mkdir':
          await device.fs.mkdir(action.path)
          break
        case 'move':
          if ((await device.fs.stat(action.path)) && !(await device.fs.stat(action.to))) {
            deleted.add(action.path)
            await device.fs.move(action.path, action.to)
          }
          break
        case 'remote':
          await owner.create(action.path, action.text)
          break
        case 'fault':
          device.network.fault = action.fault
          break
        case 'sync':
        case 'rescan':
          // Expected transport failures are inputs, never swallow invariant/setup failures.
          try {
            await device.engine[action.kind]()
          } catch (error) {
            if (
              !(error instanceof EngineError && error.code === 'offline') &&
              !(error instanceof TypeError) &&
              !(error instanceof Error && /503|simulated|response lost|http/i.test(error.message))
            )
              throw error
          }
          break
        case 'pause':
          device.engine.pause()
          break
        case 'resume':
          device.engine.resume()
          break
        case 'stop':
          await device.engine.stop()
          break
        case 'restart':
          await device.engine.stop()
          device = new SimDevice(scheduler, server.token, server.fetch, device)
          break
        case 'crash':
          device = device.crash()
          break
      }
    }
    device.network.fault = undefined
    device.engine.resume()
    await device.quiesce()
    // Server policy can hold even a single deletion. Only the trace's explicit local
    // deletions/moves authorize confirming it; quiescence must not silently waive I7.
    const held = await device.engine.heldDeletes()
    if (held.some((h) => !deleted.has(h.path)))
      throw new Error('unexpected held deletion without model intent')
    await device.engine.decideDeletes(
      'confirm',
      held.map((h) => h.fileId)
    )
    await device.quiesce()
    stages(device)
    const manifest = await owner.manifest()
    try {
      await ledger(device, manifest.cursor)
    } catch (error) {
      if (process.env.SIM_DEBUG === '1')
        console.error({ manifest, disk: [...device.fs.snapshot().keys()], lines: device.lines })
      throw error
    }
    await converged(device, manifest.items)
    await idle(device)
    return scheduler.points
  } finally {
    await device.engine.stop()
    await server.close()
  }
}

export async function saveRegression(trace: Trace, name: string) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('invalid regression name')
  const dir = new URL('./regressions/', import.meta.url)
  await mkdir(dir, { recursive: true })
  await writeFile(new URL(`${name}.json`, dir), JSON.stringify(trace, null, 2) + '\n')
}
