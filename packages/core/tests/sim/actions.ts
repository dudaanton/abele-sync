import { SimScheduler } from './scheduler.js'

export type Action =
  | { kind: 'write' | 'append' | 'remote'; path: string; text: string }
  | { kind: 'delete' | 'mkdir'; path: string }
  | { kind: 'move'; path: string; to: string }
  | { kind: 'sync' | 'rescan' | 'pause' | 'resume' | 'stop' | 'restart' | 'crash' }
  | { kind: 'fault'; fault: 'before' | 'lost' | '503' }
  | { kind: 'sameSha'; path: string }
  | { kind: 'pausePull' | 'stopPull' }
export interface Trace {
  seed: number
  actions: Action[]
  bug?: string
}

/** 60/20/15/5 local/lifecycle/network/remote weighting; bounded synthetic names. */
export function generate(seed: number, length = 30): Trace {
  const rng = new SimScheduler(seed),
    actions: Action[] = []
  for (let n = 0; n < length; n++) {
    const roll = rng.random(),
      path = `f${Math.floor(rng.random() * 8)}.md`
    const text = `${seed}:${n}:${Math.floor(rng.random() * 1000)}`
    if (roll < 0.6) {
      const kind = ['write', 'write', 'append', 'delete', 'move', 'mkdir'][
        Math.floor(rng.random() * 6)
      ]!
      if (kind === 'move') actions.push({ kind, path, to: `m${n}.md` })
      else if (kind === 'mkdir') actions.push({ kind, path: `dir${n}` })
      else if (kind === 'delete') actions.push({ kind, path })
      else actions.push({ kind: kind as 'write' | 'append', path, text })
    } else if (roll < 0.8)
      actions.push({
        kind: (['sync', 'rescan', 'pause', 'resume', 'stop', 'restart', 'crash'] as const)[
          Math.floor(rng.random() * 7)
        ]!,
      })
    else if (roll < 0.95)
      actions.push({
        kind: 'fault',
        fault: (['before', 'lost', '503'] as const)[Math.floor(rng.random() * 3)]!,
      })
    else actions.push({ kind: 'remote', path: `remote${n}.md`, text })
  }
  return { seed, actions }
}

/** Delta debugging, then value simplification. Predicate must preserve the failure signature. */
export async function shrink(
  trace: Trace,
  fails: (trace: Trace) => Promise<boolean>
): Promise<Trace> {
  let actions = trace.actions.slice()
  for (
    let width = Math.max(1, Math.floor(actions.length / 2));
    width >= 1;
    width = Math.floor(width / 2)
  ) {
    for (let at = 0; at < actions.length;) {
      const next = [...actions.slice(0, at), ...actions.slice(at + width)]
      if (await fails({ ...trace, actions: next })) actions = next
      else at += width
    }
  }
  for (let n = 0; n < actions.length; n++) {
    const action = actions[n]!
    if (!('text' in action) || action.text === '') continue
    const next = actions.slice()
    next[n] = { ...action, text: '' }
    if (await fails({ ...trace, actions: next })) actions = next
  }
  return { ...trace, actions }
}
