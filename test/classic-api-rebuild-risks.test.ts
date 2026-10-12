import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClassicApiError } from '../src/classic/api-errors.js';
import type { ClassicApiResponse, ClassicApiTransport } from '../src/classic/api-contract.js';
import { CLASSIC_API_ORIGIN } from '../src/classic/api-contract.js';
import { ClassicEndpointRegistry } from '../src/classic/endpoints.js';
import { createRequestBudget, paginateCollection } from '../src/classic/pagination.js';
import { deriveSubmissionSummary } from '../src/classic/submissions.js';
import { ClassicSnapshotV2Cache, mergeSnapshotV2WithCache, type ClassicProtectedCacheStore, type CacheFile } from '../src/classic/cache-v2.js';
import { emptyRichBody, emptySubmissionSummary, SnapshotV2Schema, type AssignmentV2, type SnapshotV2 } from '../src/classic/schema-v2.js';

function response<T>(url: URL, data: T): ClassicApiResponse<T> {
  return { status: 200, url, headers: {}, data, bytes: 0 };
}

function budget() {
  return createRequestBudget(new AbortController().signal, { deadlineMs: 10_000, requestLimit: 20 });
}

test('分页第二页失败保留第一页并标记 partial', async () => {
  const registry = new ClassicEndpointRegistry();
  const initial = registry.announcements('_123456_1', { limit: 2 });
  let calls = 0;
  const transport: ClassicApiTransport = {
    request: async request => {
      calls += 1;
      if (calls === 1) return response(request.url, {
        results: [{ id: '_announcement_1', courseId: '_123456_1' }],
        paging: { nextPage: '/learn/api/v1/courses/_123456_1/announcements?limit=2&offset=2' },
      });
      throw new ClassicApiError('NETWORK', 'synthetic second page failure', { scope: 'synthetic.pagination' });
    },
  };
  const result = await paginateCollection({ transport, initial, budget: budget(), maxPages: 3 });
  assert.equal(calls, 2);
  assert.deepEqual(result.items, [{ id: '_announcement_1', courseId: '_123456_1' }]);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0]?.code, 'NETWORK');
});

test('分页 next link 改写 userId 在下一次请求前被拒绝', async () => {
  const registry = new ClassicEndpointRegistry();
  const initial = registry.grades('_123456_1', '_user_1', { limit: 2 });
  let calls = 0;
  const transport: ClassicApiTransport = {
    request: async request => {
      calls += 1;
      return response(request.url, {
        results: [{ id: '_grade_1', courseId: '_123456_1' }],
        paging: { nextPage: '/learn/api/v1/courses/_123456_1/gradebook/grades?limit=2&offset=2&userId=_other_user&expand=lastAttempt%2Ccolumn' },
      });
    },
  };
  const result = await paginateCollection({ transport, initial, budget: budget(), maxPages: 3 });
  assert.equal(calls, 1);
  assert.equal(result.items.length, 1);
  assert.equal(result.complete, false);
  assert.equal(result.errors[0]?.code, 'URL_REJECTED');
});

test('草稿与历史已提交状态同时存在时保留已提交回执证据', () => {
  const summary = deriveSubmissionSummary({
    lastAttempt: { id: '_draft_1', status: 'IN_PROGRESS' },
    history: [
      { id: '_draft_1', status: 'IN_PROGRESS' },
      { id: '_submitted_1', status: 'NEEDS_GRADING', attemptReceipt: { receiptId: '_receipt_1', submissionDate: '2026-10-10T12:00:00+08:00', attemptId: '_submitted_1' } },
    ],
    attemptCount: 2,
    historyComplete: true,
  });
  assert.equal(summary.remoteSubmission, 'submitted');
  assert.equal(summary.latestAttemptState, 'in-progress');
  assert.equal(summary.confirmedSubmittedAttemptId, '_submitted_1');
  assert.equal(summary.receiptId, '_receipt_1');
});

class MemoryCacheStore implements ClassicProtectedCacheStore {
  value: CacheFile | null = null;
  async read(): Promise<CacheFile | null> { return this.value ? structuredClone(this.value) : null; }
  async write(value: CacheFile): Promise<void> { this.value = structuredClone(value); }
  async update(change: (previous: CacheFile | null) => CacheFile): Promise<void> { this.value = structuredClone(change(this.value ? structuredClone(this.value) : null)); }
}

function assignment(id: string, courseId = '_123456_1'): AssignmentV2 {
  return {
    id,
    courseId,
    contentId: `content-${id}`,
    columnId: `column-${id}`,
    kind: 'assignment',
    title: id,
    dueAt: null,
    dueDateOnly: null,
    dueEvidence: 'unknown',
    standardDueAt: null,
    personalDueAt: null,
    personalDueState: 'unverified',
    dueConflict: false,
    url: null,
    summary: null,
    details: emptyRichBody(),
    attachments: [],
    submission: emptySubmissionSummary(),
    provenance: { source: 'internal-api', fetchedAt: '2026-10-10T12:00:00+08:00', stale: false },
  };
}

function snapshot(assignments: readonly AssignmentV2[], assignmentState: 'complete' | 'failed' = 'complete'): SnapshotV2 {
  return SnapshotV2Schema.parse({
    schemaVersion: 2,
    state: assignmentState === 'complete' ? 'ok' : 'partial',
    fetchedAt: '2026-10-10T12:00:00+08:00',
    timezone: 'Asia/Shanghai',
    source: 'live',
    courses: [{ id: '_123456_1', name: 'Synthetic', code: null, url: null }],
    announcements: [],
    assignments,
    files: [],
    coverage: [{ courseId: '_123456_1', resource: 'assignments', state: assignmentState, received: assignments.length, pages: 1, truncated: false, restrictedNodes: 0, checkedAt: '2026-10-10T12:00:00+08:00' }],
    errors: [],
  });
}

test('成功读取的空 assignments 不从旧缓存回填', () => {
  const previous = snapshot([assignment('old-task')]);
  const current = snapshot([]);
  const merged = mergeSnapshotV2WithCache(current, previous);
  assert.deepEqual(merged.assignments, []);
  assert.equal(merged.errors.some(error => error.code === 'CACHE_FALLBACK'), false);
});

test('代次切换时 cache guard 拒绝旧结果写入', async () => {
  const store = new MemoryCacheStore();
  const cache = new ClassicSnapshotV2Cache({ store });
  const identity = { profileId: 'cuhksz', origin: CLASSIC_API_ORIGIN, userId: '_user_1', source: 'live' as const, sessionGeneration: 1 };
  let generation = 2;
  await assert.rejects(
    cache.write(identity, snapshot([]), () => {
      if (generation !== identity.sessionGeneration) throw new ClassicApiError('SESSION_EXPIRED', 'synthetic generation switch', { scope: 'synthetic.generation', retryable: false });
    }),
    error => error instanceof ClassicApiError && error.code === 'SESSION_EXPIRED',
  );
  generation = 1;
  assert.equal(store.value, null);
});
