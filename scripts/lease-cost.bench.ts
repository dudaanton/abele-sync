import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { createUser } from '../packages/server/src/access/tokens.js'
import { v2Server } from '../packages/server/tests/helpers/v2Server.js'
import { V2SyncClient } from '../packages/server/tests/helpers/v2SyncClient.js'

// Run explicitly with --config scripts/lease-cost.config.ts. Never a live provider.
for (const dialect of ['sqlite', 'pg'] as const) {
  it(`measures durable loopback upload endpoints (${dialect})`, async () => {
    const t = await v2Server(dialect)
    const samples: Record<string, number[]> = { simple: [], begin: [], part: [], complete: [] }
    try {
      const issued = await createUser(
        { db: t.db, pepper: t.config.tokenPepper },
        'Bench',
        t.address
      )
      const client = new V2SyncClient(issued.token)
      async function measure(kind: string, path: string, method: string, body?: unknown) {
        const start = performance.now()
        const response = await client.request(path, method, body)
        const bytes = await response.text()
        samples[kind]!.push(performance.now() - start)
        expect(response.ok, bytes).toBe(true)
        return bytes ? JSON.parse(bytes) : undefined
      }
      // Fixed small payloads isolate request/database cost from transfer throughput.
      for (let n = 0; n < 32000; n++) {
        const bytes = Buffer.alloc(1024)
        bytes.writeUInt32LE(n)
        const sha = createHash('sha256').update(bytes).digest('hex')
        await measure('simple', `/uploads/${sha}`, 'PUT', bytes)
      }
      for (let n = 0; n < 1000; n++) {
        const bytes = Buffer.alloc(9 * 1024, 1)
        bytes.writeUInt32LE(n)
        const sha = createHash('sha256').update(bytes).digest('hex')
        const opened = await measure('begin', `/uploads/${sha}/begin`, 'POST', {
          size: bytes.length,
          max_part_bytes: 1024,
        })
        const base = `/uploads/${sha}/${opened.upload_id}`
        for (let part = 0; part < 9; part++)
          await measure(
            'part',
            `${base}/${part}`,
            'PUT',
            bytes.subarray(part * 1024, (part + 1) * 1024)
          )
        await measure('complete', base + '/complete', 'POST')
      }
      const report = Object.fromEntries(
        Object.entries(samples).map(([kind, values]) => {
          values.sort((a, b) => a - b)
          return [
            kind,
            {
              count: values.length,
              median: values[Math.floor(values.length / 2)],
              p95: values[Math.ceil(values.length * 0.95) - 1],
            },
          ]
        })
      )
      console.log('LEASE-COST', dialect, JSON.stringify(report))
      await writeFile(`.scratch/lease-cost-${dialect}.json`, JSON.stringify(report, null, 2))
    } finally {
      await t.close()
    }
  })
}
