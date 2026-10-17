import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { decodeAccessToken, type V2Connection, type V2Selector } from '@abele/sync-protocol'
import { createUser } from '@abele/sync-server/src/access/tokens.js'
import { v2Server, type V2Server } from '@abele/sync-server/tests/helpers/v2Server.js'
import { type Dialect } from '@abele/sync-server/src/db/connect.js'
import { NodeFileSystem } from '@abele/sync-node'
import { SqliteStateStore } from '@abele/sync-node'
import {
  AccessClient,
  V2EngineClient,
  SyncEngine,
  selectiveDefaults,
  type EngineClient,
  type EngineOptions,
} from '../../src/index.js'

/** Host ports are supplied by the plugin/live driver, never simulated as consent. */
export interface AcceptanceHost {
  openNote(path: string): Promise<void>
  answerAttachment(connectionId: string, fileId: string, allow: boolean): Promise<void>
  reviewScript(candidateId: string, approve: boolean): Promise<void>
  hydrate(path: string): Promise<void>
}
export interface EngineBinding {
  engine: SyncEngine
  state: SqliteStateStore
  client: EngineClient
}
export type EngineClientFactory = (
  token: string,
  connection: V2Connection,
  transport: typeof fetch
) => EngineClient

/** Real HTTP with explicit deterministic faults. No route injection or synthetic successes. */
export class NetworkControl {
  readonly requests: Array<{ url: string; method: string }> = []
  private requestLimit = Infinity
  /** Bound work rather than throughput when a facet moves many durable files. */
  limitRequests(max: number): void {
    this.requestLimit = max
  }
  private readonly offline = new Set<string>()
  private next:
    | {
        matches: (url: string, method: string) => boolean
        effect: 'drop' | 'delay'
        release?: Promise<void>
        entered?: () => void
      }
    | undefined
  disconnect(address: string) {
    this.offline.add(address)
  }
  reconnect(address: string) {
    this.offline.delete(address)
  }
  dropNextResponse(matches: (url: string, method: string) => boolean) {
    this.next = { matches, effect: 'drop' }
  }
  private readonly barriers = new Set<() => void>()
  delayNextResponse(matches: (url: string, method: string) => boolean) {
    let resolveRelease!: () => void, arrived!: () => void
    const entered = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const promise = new Promise<void>((resolve) => {
      resolveRelease = resolve
    })
    const release = () => {
      resolveRelease()
      this.barriers.delete(release)
    }
    this.barriers.add(release)
    this.next = { matches, effect: 'delay', release: promise, entered: arrived }
    return { entered, release }
  }
  releaseAll() {
    for (const release of this.barriers) release()
    this.next = undefined
  }
  readonly fetch: typeof fetch = async (input, init) => {
    if (this.requests.length >= this.requestLimit)
      throw new Error(`acceptance HTTP work exceeded ${this.requestLimit} requests`)
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    this.requests.push({ url, method })
    if ([...this.offline].some((address) => url.startsWith(address + '/')))
      throw new TypeError('synthetic network disconnected')
    const fault = this.next?.matches(url, method) ? this.next : undefined
    if (fault !== undefined) this.next = undefined
    const response = await fetch(input, init)
    if (fault?.effect === 'drop') {
      await response.arrayBuffer()
      throw new TypeError('synthetic response lost after server applied request')
    }
    if (fault?.effect === 'delay') {
      fault.entered?.()
      await fault.release
    }
    return response
  }
}

export class AcceptanceDevice {
  readonly fs: NodeFileSystem
  readonly connections = new Map<
    string,
    { token: string; access: AccessClient; binding: EngineBinding }
  >()
  readonly network = new NetworkControl()
  private constructor(
    readonly root: string,
    readonly name: string,
    private readonly engineClient: EngineClientFactory,
    private readonly engineOptions: Pick<EngineOptions, 'defer'>
  ) {
    this.fs = new NodeFileSystem(root, { preserveEmptyDirectories: true })
  }
  static async create(
    root: string,
    name: string,
    engineClient: EngineClientFactory,
    engineOptions: Pick<EngineOptions, 'defer'> = {}
  ) {
    await mkdir(root, { recursive: true })
    return new AcceptanceDevice(root, name, engineClient, engineOptions)
  }
  async paste(token: string, localId = 'primary') {
    const access = AccessClient.fromToken(token, { fetch: this.network.fetch })
    // A refused token must not create local connection/state, let alone start file exchange.
    const connection = await access.connection()
    if (connection.status !== 'active') throw new Error(`connection ${connection.status}`)
    if (this.connections.has(localId)) throw new Error('connection ID already exists')
    const client = this.engineClient(token, connection, this.network.fetch)
    const state = SqliteStateStore.open(join(this.root, '.abele-sync', `${localId}.db`))
    const engine = new SyncEngine({
      client,
      fs: this.fs,
      state,
      selective: selectiveDefaults(),
      deleteGuard: false,
      ...this.engineOptions,
    })
    this.connections.set(localId, { token, access, binding: { engine, state, client } })
    await this.persist()
    return connection
  }
  qr(payload: string, localId?: string) {
    return this.paste(payload, localId)
  }
  async issue(localId: string, scope: V2Selector, label: string) {
    return this.connection(localId).access.issue({ scope, label })
  }
  revoke(localId: string, tokenId: string) {
    return this.connection(localId).access.revoke(tokenId)
  }
  connection(id: string) {
    const value = this.connections.get(id)
    if (value === undefined) throw new Error(`unknown connection ${id}`)
    return value
  }
  write(path: string, content: string) {
    return this.fs.writeAtomic(path, new TextEncoder().encode(content), Date.now())
  }
  move(from: string, to: string) {
    return this.fs.move(from, to)
  }
  delete(path: string) {
    return this.fs.remove(path)
  }
  async text(path: string) {
    // Assertions name wire paths; the local disk may keep a different Unicode spelling.
    if ((await this.fs.stat(path)) === null)
      for await (const file of this.fs.list())
        if (file.path.normalize('NFC') === path.normalize('NFC')) {
          path = file.path
          break
        }
    return new TextDecoder().decode(await this.fs.read(path))
  }
  sync(id: string) {
    return this.connection(id).binding.engine.sync()
  }
  async disconnect(id: string) {
    const value = this.connection(id)
    await value.binding.engine.stop()
    value.binding.state.close()
    this.connections.delete(id)
    await this.persist()
  }
  async restart() {
    await this.close()
    const records = JSON.parse(
      await readFile(join(this.root, '.abele-sync', 'connections.json'), 'utf8')
    ) as Record<string, string>
    for (const [id, token] of Object.entries(records)) await this.paste(token, id)
  }
  async close() {
    this.network.releaseAll()
    for (const value of this.connections.values()) {
      await value.binding.engine.stop()
      value.binding.state.close()
    }
    this.connections.clear()
  }
  private async persist() {
    const dir = join(this.root, '.abele-sync')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'connections.json'),
      JSON.stringify(
        Object.fromEntries([...this.connections].map(([id, value]) => [id, value.token]))
      )
    )
  }
}

/** Two independent durable databases/listeners/blob stores and three real-disk production engines.
 * The default is the production v2 adapter, never an account/device translation. */
export async function acceptanceFixture(
  dialect: Dialect = 'sqlite',
  engineClient: EngineClientFactory = (encoded, _connection, transport) =>
    new V2EngineClient(encoded, { fetch: transport }),
  engineOptions: Pick<EngineOptions, 'defer'> = {}
) {
  const scratch = resolve('.scratch')
  await mkdir(scratch, { recursive: true })
  const dir = await mkdtemp(join(scratch, 'acceptance-'))
  const servers: V2Server[] = []
  const devices: AcceptanceDevice[] = []
  try {
    servers.push(await v2Server(dialect), await v2Server(dialect))
    const roots = await Promise.all(
      servers.map((server) =>
        createUser(
          { db: server.db, pepper: server.config.tokenPepper, dialect },
          'Synthetic owner',
          server.address
        )
      )
    )
    for (const name of ['A', 'B', 'C'])
      devices.push(
        await AcceptanceDevice.create(join(dir, name), name, engineClient, engineOptions)
      )
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]!
      const owner = AccessClient.fromToken(root.token, { fetch })
      for (const device of devices) {
        const issued = await owner.issue({
          scope: { kind: root.info.scope.kind, id: root.info.scope.id },
          label: device.name,
        })
        await device.paste(issued.token, `server-${index + 1}`)
      }
    }
    return {
      dir,
      servers,
      roots,
      devices,
      async close() {
        for (const device of devices) await device.close()
        for (const server of servers) await server.close()
        await rm(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    for (const device of devices) await device.close()
    for (const server of servers) await server.close()
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}
export type AcceptanceFixture = Awaited<ReturnType<typeof acceptanceFixture>>
