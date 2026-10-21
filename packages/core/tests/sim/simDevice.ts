import { SyncEngine, V2EngineClient, selectiveDefaults } from '../../src/index.js'
import { SimScheduler } from './scheduler.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { CountingTransport } from './network.js'

export class SimDevice {
  readonly lines: string[] = []
  readonly engine: SyncEngine
  readonly client: V2EngineClient
  readonly network: CountingTransport
  readonly fs: MemoryStreamingFS
  readonly state: DurableStateStore
  constructor(
    readonly scheduler: SimScheduler,
    private token: string,
    private transport: typeof fetch,
    previous?: SimDevice
  ) {
    this.fs = previous?.fs.reopen() ?? new MemoryStreamingFS(scheduler)
    this.state = previous?.state.reopen() ?? new DurableStateStore(scheduler)
    this.network = new CountingTransport(scheduler, transport)
    const client = new V2EngineClient(token, { fetch: this.network.fetch })
    const epoch = scheduler.epoch
    const network = this.network
    const methods = new Map<PropertyKey, unknown>()
    this.client = new Proxy(client, {
      get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        if (!methods.has(key))
          methods.set(key, (...args: unknown[]) => {
            scheduler.fence(epoch)
            if (key === 'includes' || key === 'subscribe') return Reflect.apply(value, target, args)
            return (async () => {
              await scheduler.point(`client.${String(key)}`, epoch)
              if (key === 'openVersion')
                network.expectVersion(
                  String(args[0]),
                  String(args[1]),
                  (args[2] as { sha: string }).sha
                )
              const result: unknown = await Reflect.apply(value, target, args)
              scheduler.fence(epoch)
              return result
            })()
          })
        return methods.get(key)
      },
    })
    this.engine = new SyncEngine({
      client: this.client,
      fs: this.fs,
      state: this.state,
      selective: selectiveDefaults(),
      now: scheduler.now,
      deleteGuard: false,
      log: (line) => this.lines.push(line),
    })
  }
  crash() {
    if (this.fs.epoch === this.scheduler.epoch) this.scheduler.crash()
    return new SimDevice(this.scheduler, this.token, this.transport, this)
  }
  async write(path: string, text: string) {
    await this.fs.writeAtomic(path, new TextEncoder().encode(text), this.scheduler.now())
  }
  async quiesce() {
    for (let n = 0; n < 3; n++) await this.engine.sync()
  }
}
