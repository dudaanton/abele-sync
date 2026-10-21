export class EpochError extends Error {
  constructor() { super('abandoned epoch') }
}

/** Named, replayable boundaries. A cut invalidates every handle from the old process. */
export class SimScheduler {
  epoch = 0
  time = 1_700_000_000_000
  readonly points: string[] = []
  private counts = new Map<string, number>()
  cut: string | undefined
  hook: ((point: string) => Promise<void>) | undefined
  constructor(private seed: number) {}
  random = (): number => {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 0x100000000
  }
  now = (): number => ++this.time
  uuid = (): string => '00000000-0000-4000-8000-' + Math.floor(this.random() * 2 ** 48).toString(16).padStart(12, '0')
  crash(): void { this.epoch++ }
  fence(epoch: number): void { if (epoch !== this.epoch) throw new EpochError() }
  async point(label: string, epoch = this.epoch): Promise<void> {
    this.fence(epoch)
    const occurrence = (this.counts.get(label) ?? 0) + 1
    this.counts.set(label, occurrence)
    const point = `${label}#${occurrence}`
    this.points.push(point)
    if (point === this.cut) this.crash()
    await this.hook?.(point)
    await Promise.resolve()
    this.fence(epoch)
  }
}
