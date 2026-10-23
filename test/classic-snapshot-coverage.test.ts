import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClassicApiClient } from '../src/classic/api-client.js';
import { ClassicApiError } from '../src/classic/api-errors.js';
import { readClassicSnapshot } from '../src/classic/api-snapshot.js';
import { mergeSnapshotV2WithCache } from '../src/classic/cache-v2.js';
import { readAssignmentDetail, type ClassicResourceRegistrar } from '../src/classic/detail-reader.js';
import { emptySubmissionSummary, type AssignmentV2 } from '../src/classic/schema-v2.js';

const courseId = '_123456_1';
function page<T>(items: T[], complete = true) {
  return { items, complete, truncated: false, pages: 1, nextPage: null, errors: [] };
}

function apiWithColumns(mode: 'present' | 'failed' | 'empty'): ClassicApiClient {
  return {
    account: { profileId: 'cuhksz', origin: 'https://bb.cuhk.edu.cn', userId: '_user_1', sessionGeneration: 1, timezone: 'Asia/Shanghai' },
    identity: async () => ({ id: '_user_1' }),
    memberships: async () => page([{ course: { id: courseId, name: 'Synthetic course' } }]),
    calendar: async () => page([]),
    announcements: async () => page([]),
    contents: async () => page([]),
    gradeColumns: async () => {
      if (mode === 'failed') throw new ClassicApiError('NETWORK', 'Synthetic failure', { scope: 'api:grades' });
      return page(mode === 'empty' ? [] : [{ id: '_22_1', contentId: '_11_1', title: 'Column-only assignment' }]);
    },
    grades: async () => page([]),
  } as unknown as ClassicApiClient;
}

test('内容树完整但评分列失败时，保留上次评分列作业并标记过期', async () => {
  const options = { signal: new AbortController().signal };
  const previous = (await readClassicSnapshot(apiWithColumns('present'), options)).snapshot;
  assert.equal(previous.assignments.length, 1);
  assert.equal(previous.coverage.find(entry => entry.resource === 'assignments')?.received, 1);
  const failed = (await readClassicSnapshot(apiWithColumns('failed'), options)).snapshot;
  assert.notEqual(failed.coverage.find(entry => entry.resource === 'assignments')?.state, 'complete');
  const merged = mergeSnapshotV2WithCache(failed, previous);
  assert.equal(merged.assignments.length, 1);
  assert.equal(merged.assignments[0]?.provenance.stale, true);
  const removed = (await readClassicSnapshot(apiWithColumns('empty'), options)).snapshot;
  assert.equal(removed.coverage.find(entry => entry.resource === 'assignments')?.state, 'complete');
  assert.deepEqual(mergeSnapshotV2WithCache(removed, previous).assignments, []);
});

test('日历重复分页在快照中显示准确说明，保留 partial 和截断状态', async () => {
  const api = apiWithColumns('empty');
  api.calendar = async () => ({
    ...page([]), complete: false, truncated: true,
    errors: [new ClassicApiError('PARTIAL_RESULTS', 'Synthetic calendar loop', { scope: 'pagination:calendar:repeat', retryable: false }).toPublic()],
  });
  const snapshot = (await readClassicSnapshot(api, { signal: new AbortController().signal })).snapshot;
  const error = snapshot.errors.find(item => item.scope === 'pagination:calendar:repeat');
  assert.equal(snapshot.state, 'partial');
  assert.equal(error?.code, 'PARTIAL_RESULTS');
  assert.match(error?.message ?? '', /日历分页重复.*完整性尚未确认/);
  const calendar = snapshot.coverage.find(item => item.resource === 'calendar');
  assert.notEqual(calendar?.state, 'complete');
  assert.equal(calendar?.truncated, true);
});

test('作业详情为裸 xid 图片提供同课程来源页，拒绝外站图片', async () => {
  const registrations: Parameters<ClassicResourceRegistrar['register']>[0][] = [];
  const assignment: AssignmentV2 = {
    id: '_11_1', courseId, contentId: '_11_1', columnId: null, kind: 'assignment', title: 'Synthetic',
    dueAt: null, dueDateOnly: null, dueEvidence: 'unknown', standardDueAt: null, personalDueAt: null,
    personalDueState: 'unverified', dueConflict: false, url: null, summary: null, details: null,
    attachments: [], submission: emptySubmissionSummary(),
    provenance: { source: 'internal-api', fetchedAt: '2026-10-23T10:00:00+08:00', stale: false },
  };
  const api = {
    contentDetail: async () => ({ id: '_11_1', title: 'Synthetic', body: '<img src="/bbcswebdav/xid-123_1"><img src="https://external.example/image.png">' }),
    attachments: async () => page([]),
  } as unknown as ClassicApiClient;
  const result = await readAssignmentDetail(api, assignment, {
    signal: new AbortController().signal,
    resourceRegistry: { register: options => { registrations.push(options); return 'synthetic-image'; } },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.resourceKey, '123_1');
  const source = new URL(String(registrations[0]?.sourcePageUrl));
  assert.equal(source.searchParams.get('course_id'), courseId);
  assert.equal(source.searchParams.get('content_id'), '_11_1');
  assert.match(result.assignment.details?.sanitizedHtml ?? '', /lms-resource:\/\/resource\/synthetic-image/);
  assert.doesNotMatch(result.assignment.details?.sanitizedHtml ?? '', /external\.example/);
});
