import { SimScheduler } from './scheduler.js'

export interface RequestRecord {
  path: string
  method: string
  bytes: number
  status: number
  sha?: string
}
export class CountingTransport {
  readonly requests: RequestRecord[] = []
  fault: 'before' | 'lost' | '503' | undefined
  private barrier: { entered: () => void; wait: Promise<void> } | undefined
  holdNext() {
    let entered!: () => void, release!: () => void
    const arrived = new Promise<void>((resolve) => {
      entered = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    this.barrier = { entered, wait }
    return { entered: arrived, release }
  }
  readonly epoch: number
  private ids = new Map<string, string>()
  private identities = new Map<string, string>()
  expectVersion(fileId: string, versionId: string, sha: string) {
    this.identities.set(`${fileId}:${versionId}`, sha)
  }
  constructor(
    private scheduler: SimScheduler,
    private transport: typeof fetch
  ) {
    this.epoch = scheduler.epoch
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const method = init?.method ?? 'GET'
    const label = url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => {
      if (!this.ids.has(id)) this.ids.set(id, `id${this.ids.size}`)
      return this.ids.get(id)!
    })
    await this.scheduler.point(`net.before.${method}.${label}`, this.epoch)
    const barrier = this.barrier
    this.barrier = undefined
    if (barrier) {
      barrier.entered()
      await barrier.wait
      this.scheduler.fence(this.epoch)
    }
    const fault = this.fault
    this.fault = undefined
    if (fault === 'before') throw new TypeError('simulated offline')
    if (fault === '503') return new Response('', { status: 503 })
    const response = await this.transport(input, init)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const fileId = url.pathname.match(/\/files\/([^/]+)\/content$/)?.[1]
    const sha = fileId
      ? this.identities.get(`${fileId}:${url.searchParams.get('version_id')}`)
      : undefined
    this.requests.push({
      path: url.pathname,
      method,
      bytes: bytes.length,
      status: response.status,
      ...(sha ? { sha } : {}),
    })
    await this.scheduler.point(`net.after.${method}.${label}`, this.epoch)
    if (fault === 'lost') throw new TypeError('applied response lost')
    return new Response([204, 304].includes(response.status) || method === 'HEAD' ? null : bytes, {
      status: response.status,
      headers: response.headers,
    })
  }
  get downloads() {
    return this.requests.filter(
      (r) => r.method === 'GET' && r.path.endsWith('/content') && r.status < 300
    )
  }
  get downloadedBySha() {
    const counts = new Map<string, number>()
    for (const request of this.downloads)
      if (request.sha) counts.set(request.sha, (counts.get(request.sha) ?? 0) + request.bytes)
    return counts
  }
  get commits() {
    return this.requests.filter(
      (r) => r.method === 'POST' && r.path === '/v2/commit' && r.status < 300
    )
  }
}
