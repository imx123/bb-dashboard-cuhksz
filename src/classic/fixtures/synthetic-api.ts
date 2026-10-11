import { normalizeSnapshot } from '../normalize.js';
import { parseSnapshotV2, type SnapshotV2 } from '../schema-v2.js';

/** Offline-only synthetic payload. It contains no school, account, or live URL. */
export const CLASSIC_API_SYNTHETIC_RAW = {
  courses: [{ id: 'fixture-course-1', name: 'Synthetic Course', code: 'SYN-101', url: 'https://example.invalid/courses/fixture-course-1', available: true }],
  announcements: [{
    id: 'fixture-announcement-1', courseId: 'fixture-course-1', title: 'Synthetic announcement',
    body: { displayText: 'Synthetic body only; no live Blackboard data.' },
    createdAt: '2026-10-11T09:00:00+08:00', modifiedAt: '2026-10-11T09:05:00+08:00',
    url: 'https://example.invalid/courses/fixture-course-1/announcements/fixture-announcement-1',
  }],
  assignments: [{
    id: 'fixture-assignment-1', courseId: 'fixture-course-1', contentId: 'fixture-content-assignment-1',
    columnId: 'fixture-column-1', kind: 'assignment', title: 'Synthetic assignment',
    dueAt: '2026-10-20T23:59:00+08:00', dueEvidence: 'blackboard-field',
    url: 'https://example.invalid/courses/fixture-course-1/content/fixture-content-assignment-1',
    submission: { status: 'IN_PROGRESS', historyComplete: true, history: [] },
  }],
  files: [{
    id: 'fixture-file-1', courseId: 'fixture-course-1', contentId: 'fixture-content-file-1',
    name: 'Synthetic handout.pdf', kind: 'file', mimeType: 'application/pdf',
    url: 'https://example.invalid/courses/fixture-course-1/content/fixture-content-file-1',
  }],
  coverage: [
    { courseId: null, resource: 'courses', state: 'complete', received: 1, pages: 1, truncated: false, restrictedNodes: 0, checkedAt: '2026-10-11T09:05:00+08:00' },
    { courseId: 'fixture-course-1', resource: 'announcements', state: 'complete', received: 1, pages: 1, truncated: false, restrictedNodes: 0, checkedAt: '2026-10-11T09:05:00+08:00' },
    { courseId: 'fixture-course-1', resource: 'assignments', state: 'complete', received: 1, pages: 1, truncated: false, restrictedNodes: 0, checkedAt: '2026-10-11T09:05:00+08:00' },
    { courseId: 'fixture-course-1', resource: 'files', state: 'complete', received: 1, pages: 1, truncated: false, restrictedNodes: 0, checkedAt: '2026-10-11T09:05:00+08:00' },
  ],
  errors: [],
} as const;

export function syntheticSnapshotV2(): SnapshotV2 {
  return parseSnapshotV2(normalizeSnapshot({
    state: 'ok', fetchedAt: '2026-10-11T09:05:00+08:00', source: 'offline-fixture',
    ...CLASSIC_API_SYNTHETIC_RAW,
  }, { fetchedAt: '2026-10-11T09:05:00+08:00', source: 'public-api' }));
}
