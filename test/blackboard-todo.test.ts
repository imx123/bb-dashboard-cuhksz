import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardClient } from '../vendor/blackboard/src/client/index.js';
import { ConfigSchema } from '../vendor/blackboard/src/config.js';
import { BlackboardError } from '../vendor/blackboard/src/lib/errors.js';
import type { HttpClient, RequestOptions } from '../vendor/blackboard/src/client/http.js';

const window = { since: '2026-09-01T00:00:00Z', until: '2026-10-01T00:00:00Z' };
function client(json: (options: RequestOptions) => Promise<unknown>) {
  return new BlackboardClient({ json } as HttpClient, ConfigSchema.parse({ baseUrl: 'https://learn.example.edu' }));
}
test('normal Blackboard todo buckets and a verified empty list remain unchanged', async () => {
  const c = client(async () => ({ overdueItems: [{ title: 'Essay', column: { id: '_1_1', courseId: '_2_1' } }], dueTodayItems: [], futureDueItems: [] }));
  const result = await c.listTodoWithCoverage(window);
  assert.equal(result.source, 'todo'); assert.equal(result.items[0]!._courseId, '_2_1'); assert.equal(result.items[0]!._bucket, 'overdue');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual((await client(async () => ({ overdueItems: [], dueTodayItems: [], futureDueItems: [] })).listTodoWithCoverage(window)).items, []);
});
test('a tenant date-window limit is handled by splitting the real todo endpoint', async () => {
  const calls: RequestOptions[] = [];
  const c = client(async options => {
    calls.push(options);
    const since = Date.parse(String(options.query?.since));
    const until = Date.parse(String(options.query?.until));
    assert(until - since <= 15 * 86_400_000);
    return { overdueItems: [{ title: `Essay-${calls.length}`, column: { id: `_${calls.length}_1`, courseId: '_2_1' } }], dueTodayItems: [], futureDueItems: [] };
  });
  const result = await c.listTodoWithCoverage({ since: '2026-08-01T00:00:00Z', until: '2026-10-01T00:00:00Z' });
  assert.equal(result.source, 'todo'); assert.equal(result.warnings.length, 0);
  assert.equal(calls.length, 5); // 61 days, max 15 days per request.
  assert(result.items.every(item => item._bucket === 'overdue'));
});
test('unsupported todo responses are returned as real errors, never as calendar success', async () => {
  for (const error of [new BlackboardError('NOT_FOUND', 'widget missing', { status: 404 }), new BlackboardError('UNSUPPORTED', 'changed envelope')]) {
    await assert.rejects(client(async () => { throw error; }).listTodoWithCoverage(window), e => e === error);
  }
});
test('auth, permissions, throttling and network failures are not masked', async () => {
  for (const code of ['SESSION_EXPIRED', 'NOT_AUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'NETWORK'] as const) {
    let calls = 0; const error = new BlackboardError(code, 'synthetic failure');
    await assert.rejects(client(async () => { calls++; throw error; }).listTodoWithCoverage(window), e => e === error);
    assert.equal(calls, 1);
  }
});
