import type { StateStore } from './state.js'

const PREFIX = 'settlement-departure:index:'
export function sequenceKey(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1)
    throw new Error('invalid settlement sequence')
  return sequence.toString(16).padStart(14, '0')
}

async function bitmap(state: StateStore, prefix: string): Promise<number> {
  const raw = await state.getMeta?.(PREFIX + prefix)
  if (raw == null) return 0
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error('invalid settlement index')
  return value
}

/** Fixed-depth radix index: no queue serialization, enumeration or recursive stack.
 * Mutate only with the corresponding obligation in the same scoped transaction. */
export async function indexSettlement(state: StateStore, sequence: number, present: boolean) {
  const key = sequenceKey(sequence)
  for (let length = key.length - 1; length >= 0; length--) {
    const prefix = key.slice(0, length)
    const bit = 1 << parseInt(key[length]!, 16)
    const before = await bitmap(state, prefix)
    const after = present ? before | bit : before & ~bit
    if (after === before) return
    await state.setMeta!(PREFIX + prefix, after ? String(after) : null)
    // An existing parent already represents this nonempty subtree.
    if (present ? before !== 0 : after !== 0) return
  }
}

export async function firstSettlementSequence(state: StateStore): Promise<number | null> {
  let prefix = ''
  for (let depth = 0; depth < 14; depth++) {
    const mask = await bitmap(state, prefix)
    if (!mask) {
      if (depth === 0) return null
      throw new Error('incomplete settlement index')
    }
    let digit = 0
    while (!(mask & (1 << digit))) digit++
    prefix += digit.toString(16)
  }
  const sequence = parseInt(prefix, 16)
  sequenceKey(sequence)
  return sequence
}
