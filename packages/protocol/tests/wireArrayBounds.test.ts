import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

// Use the actual built wire schemas, isolated from the worker's heap and clock.
// First guard traversal so a vulnerable dependency fails without allocating an
// unbounded issue tree; then measure an ordinary decoded JSON payload.
it.each([
  ['CommitRequestSchema', 'ops', {}],
  ['V2CommitRequestSchema', 'ops', {}],
  ['ScopedCommitRequestSchema', 'ops', { request_id: 'request' }],
  ['TrashRestoreRequestSchema', 'file_ids', {}],
  [
    'ScopedFeedPageSchema',
    'events',
    { checkpoint: { kind: 'scoped', token: 'c' }, has_more: false },
  ],
] as const)('bounds oversized %s arrays before inspecting elements', (name, field, rest) => {
  const module = new URL('../dist/index.js', import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=96',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const { ${name}: schema } = await import(${JSON.stringify(module)});
    const items = JSON.parse('[' + Array(100000).fill('null').join(',') + ']');
    let visits = 0;
    const guarded = new Proxy(items, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\\d+$/.test(key) && ++visits > 1024)
        throw new Error('oversized array traversed past the validation budget');
      return Reflect.get(target, key, receiver);
    }});
    const payload = ${JSON.stringify(rest)};
    const guardedResult = schema.safeParse({ ...payload, [${JSON.stringify(field)}]: guarded });
    assert.equal(guardedResult.success, false);
    assert.equal(visits, 0, 'oversized arrays must not inspect elements');
    const before = process.memoryUsage().heapUsed;
    const start = performance.now();
    const parsed = schema.safeParse({ ...payload, [${JSON.stringify(field)}]: items });
    const elapsed = performance.now() - start;
    const allocated = process.memoryUsage().heapUsed - before;
    assert.equal(parsed.success, false);
    assert.equal(parsed.error.issues.length, 1);
    assert.equal(parsed.error.issues[0].code, 'too_big');
    assert.deepEqual(parsed.error.issues[0].path, [${JSON.stringify(field)}]);
    assert.ok(allocated < 8 * 1024 * 1024, 'validation allocated ' + allocated + ' bytes');
    assert.ok(elapsed < 500, 'validation took ' + elapsed + ' ms');
    console.log(JSON.stringify({ visits, allocated, elapsed }));
  `,
    ],
    { timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' }
  )
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).visits).toBe(0)
  console.info(`${name}: ${result.stdout.trim()}`)
})
