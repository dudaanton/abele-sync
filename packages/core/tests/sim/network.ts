import { SimScheduler } from './scheduler.js'

export interface RequestRecord { path: string; method: string; bytes: number; status: number }
export class CountingTransport {
  readonly requests: RequestRecord[] = []
  fault: 'before' | 'lost' | '503' | undefined
  readonly epoch: number
  constructor(private scheduler: SimScheduler, private transport: typeof fetch) { this.epoch = scheduler.epoch }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    await this.scheduler.point(`net.before.${method}.${url.pathname}`, this.epoch)
    const fault = this.fault; this.fault = undefined
    if (fault === 'before') throw new TypeError('simulated offline')
    if (fault === '503') return new Response('', { status: 503 })
    const response = await this.transport(input, init)
    const bytes = new Uint8Array(await response.arrayBuffer())
    this.requests.push({ path: url.pathname, method, bytes: bytes.length, status: response.status })
    await this.scheduler.point(`net.after.${method}.${url.pathname}`, this.epoch)
    if (fault === 'lost') throw new TypeError('applied response lost')
    return new Response([204, 304].includes(response.status) || method === 'HEAD' ? null : bytes, { status: response.status, headers: response.headers })
  }
  get downloads() { return this.requests.filter(r => r.method === 'GET' && r.path.endsWith('/content') && r.status < 300) }
  get commits() { return this.requests.filter(r => r.method === 'POST' && r.path === '/v2/commit' && r.status < 300) }
}
