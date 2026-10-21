import { SyncEngine, V2EngineClient, selectiveDefaults } from '../../src/index.js'
import { SimScheduler } from './scheduler.js'
import { DurableStateStore } from './durableState.js'
import { MemoryStreamingFS } from './streamingMemoryFs.js'
import { CountingTransport } from './network.js'

export class SimDevice {
  readonly engine: SyncEngine
  readonly client: V2EngineClient
  readonly network: CountingTransport
  readonly fs: MemoryStreamingFS
  readonly state: DurableStateStore
  constructor(readonly scheduler: SimScheduler, private token: string, private transport: typeof fetch, previous?: SimDevice) {
    this.fs = previous?.fs.reopen() ?? new MemoryStreamingFS(scheduler)
    this.state = previous?.state.reopen() ?? new DurableStateStore(scheduler)
    this.network = new CountingTransport(scheduler, transport)
    this.client = new V2EngineClient(token, { fetch: this.network.fetch, retries: 0 })
    this.engine = new SyncEngine({ client: this.client, fs: this.fs, state: this.state, selective: selectiveDefaults(), now: scheduler.now, deleteGuard: false })
  }
  crash() { this.scheduler.crash(); return new SimDevice(this.scheduler, this.token, this.transport, this) }
  async write(path: string, text: string) { await this.fs.writeAtomic(path, new TextEncoder().encode(text), this.scheduler.now()) }
  async quiesce() { for (let n = 0; n < 3; n++) await this.engine.sync() }
}
