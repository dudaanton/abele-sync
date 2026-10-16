type Category = 'request failed' | 'token use sample failed' | 'activity counters failed'
const samples = new WeakMap<
  object,
  Partial<Record<Category, { at: number; messages: Set<string> }>>
>()

/** Fixed categories, at most ten distinct bounded diagnostics per minute. */
export function operationalLog(owner: object, category: Category, error: unknown) {
  let last = samples.get(owner)
  if (!last) samples.set(owner, (last = {}))
  const now = Date.now()
  const message = error instanceof Error ? error.message : 'non-Error failure'
  const bounded = message.slice(0, 1024).replace(/[\r\n\u001b]/g, ' ')
  let sample = last[category]
  if (!sample || now - sample.at >= 60000)
    last[category] = sample = { at: now, messages: new Set() }
  if (sample.messages.size >= 10 || sample.messages.has(bounded)) return
  sample.messages.add(bounded)
  console.error(category + ':', bounded)
}
