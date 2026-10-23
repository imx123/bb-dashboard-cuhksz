import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClassicApiClient } from '../src/classic/api-client.js';
import { ClassicApiError } from '../src/classic/api-errors.js';
import type { ClassicApiResponse, ClassicApiTransport, ClassicSession } from '../src/classic/api-contract.js';
import { ClassicEndpointRegistry } from '../src/classic/endpoints.js';
import { createRequestBudget, paginateCollection } from '../src/classic/pagination.js';
import { RawCalendarItemSchema } from '../src/classic/raw-schema.js';

const day = 86400000;
const start = Date.parse('2026-08-01T00:00:00Z');
const iso = (time: number) => new Date(time).toISOString();
const budget = () => createRequestBudget(new AbortController().signal, { requestLimit: 30 });
const row = (time: number, id = 'synthetic-column') => ({
  calendarId: 'synthetic-calendar', itemSourceType: 'blackboard.platform.gradebook2.GradableItem',
  itemSourceId: id, startDate: iso(time), endDate: iso(time),
});
function response<T>(url: URL, data: T): ClassicApiResponse<T> {
  return { status: 200, url, headers: {}, data, bytes: 0 };
}
function navigation(url: URL, results: unknown[]) {
  const next = new URL(url.pathname, url);
  next.searchParams.set('limit', url.searchParams.get('limit')!);
  next.searchParams.set('until', iso(Date.parse(url.searchParams.get('since')!) + 28 * day));
  return { results, paging: { count: results.length, limit: 14, offset: 0, nextPage: next.href } };
}
function client(transport: ClassicApiTransport): ClassicApiClient {
  return new ClassicApiClient({ transport, session: {
    state: 'authenticated',
    account: { profileId: 'synthetic', origin: 'https://bb.cuhk.edu.cn', userId: 'synthetic-user', sessionGeneration: 1, timezone: 'Asia/Shanghai' },
  } as ClassicSession });
}

test('日历逐段覆盖十六周，不追缺少 since 的时间导航，所有段共用请求预算', async () => {
  const requested: URL[] = [];
  const shared = budget();
  const api = client({ request: async request => {
    requested.push(new URL(request.url));
    assert.equal(request.budget, shared);
    const since = Date.parse(request.url.searchParams.get('since')!);
    return response(request.url, navigation(request.url, [row(since + day, `column-${requested.length}`)]));
  } });
  const result = await api.calendar({ signal: shared.signal, budget: shared }, iso(start), iso(start + 112 * day));
  assert.equal(requested.length, 8);
  assert.equal(result.items.length, 8);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.errors, []);
  for (let index = 0; index < requested.length; index++) {
    assert.equal(requested[index]!.searchParams.get('since'), iso(start + index * 14 * day));
    assert.equal(requested[index]!.searchParams.get('until'), iso(start + (index + 1) * 14 * day));
  }
});

test('相邻含边界时间段只合并完全相同的记录，保留发生变化的记录', async () => {
  for (const changed of [false, true]) {
    let calls = 0;
    const api = client({ request: async request => {
      calls++;
      const item = { ...row(start + 14 * day), modifiedDate: iso(start + (changed ? calls : 1) * day) };
      return response(request.url, navigation(request.url, [item]));
    } });
    const result = await api.calendar({ signal: new AbortController().signal }, iso(start), iso(start + 28 * day));
    assert.equal(calls, 2);
    assert.equal(result.complete, true);
    assert.equal(result.items.length, changed ? 2 : 1);
  }
});

test('导航适配不吞掉异常来源、未知游标、满页、计数矛盾或条目解析错误', async () => {
  const initial = new ClassicEndpointRegistry().calendar(iso(start), iso(start + 14 * day));
  for (const variant of ['origin', 'selector', 'full', 'count', 'item'] as const) {
    let calls = 0;
    const result = await paginateCollection({ initial, budget: budget(), mapItem: value => RawCalendarItemSchema.parse(value), transport: {
      request: async request => {
        calls++;
        const data = navigation(request.url, variant === 'full'
          ? Array.from({ length: 14 }, (_, index) => row(start + day, `column-${index}`))
          : [{ ...row(start + day), ...(variant === 'item' ? { id: {} } : {}) }]);
        if (variant === 'origin') data.paging.nextPage = data.paging.nextPage.replace('bb.cuhk.edu.cn', 'example.invalid');
        if (variant === 'selector') data.paging.nextPage += '&userId=other';
        if (variant === 'count') data.paging.count++;
        return response(request.url, data);
      },
    } });
    assert.equal(calls, 1);
    assert.equal(result.complete, false, variant);
    assert.ok(result.errors.length > 0, variant);
  }
});

test('后续时间段失败时保留前段并标记未覆盖范围，二十页上限不按段重置', async () => {
  for (const failure of [true, false]) {
    let calls = 0;
    const api = client({ request: async request => {
      calls++;
      if (failure && calls === 2) throw new ClassicApiError('NETWORK', 'Synthetic failure', { scope: 'synthetic.calendar' });
      const since = Date.parse(request.url.searchParams.get('since')!);
      return response(request.url, navigation(request.url, [row(since + day, `column-${calls}`)]));
    } });
    const result = await api.calendar({ signal: new AbortController().signal }, iso(start), iso(start + 300 * day));
    assert.equal(calls, failure ? 2 : 20);
    assert.equal(result.items.length, failure ? 1 : 20);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(result.errors[0]?.code, failure ? 'NETWORK' : 'PARTIAL_RESULTS');
  }
});
