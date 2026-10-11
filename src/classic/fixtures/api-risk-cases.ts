/**
 * Offline-only risk payloads for the JSON reader review.
 *
 * These values are deliberately synthetic and use example.invalid identifiers.
 * They are data declarations for a future user-run test harness; importing the
 * module performs no I/O, login, HTTP request, or assertion.
 */
export const CLASSIC_API_RISK_CASES = {
  paginationLoop: {
    initialUrl: 'https://example.invalid/learn/api/v1/courses/fixture-course-1/contents/ROOT/children?limit=100&offset=0',
    results: [{ id: 'fixture-item-1' }],
    paging: { nextPage: '?limit=100&offset=0' },
    expected: 'partial-with-pagination-error',
  },
  paginationCrossCourse: {
    initialUrl: 'https://example.invalid/learn/api/v1/courses/fixture-course-1/contents/ROOT/children?limit=100',
    results: [{ id: 'fixture-item-2' }],
    paging: { nextPage: 'https://example.invalid/learn/api/v1/courses/other/contents/ROOT/children?limit=100' },
    expected: 'course-scope-rejected-before-follow',
  },
  unknownHandler: {
    id: 'fixture-unknown-content',
    courseId: 'fixture-course-1',
    title: 'Synthetic unknown material',
    contentHandler: 'resource/x-example-unreviewed',
    hasChildren: true,
    expected: 'visible-unknown-without-child-probe',
  },
  restrictedFolder: {
    id: 'fixture-restricted-folder',
    courseId: 'fixture-course-1',
    title: 'Synthetic restricted folder',
    availability: { available: false, isPartiallyVisible: false },
    expected: 'restricted-without-child-probe',
  },
  submissionEvidence: {
    completed: {
      id: 'fixture-attempt-completed',
      status: 'COMPLETED',
      attemptReceipt: {
        receiptId: 'fixture-receipt-1',
        submissionDate: '2026-10-11T09:00:00+08:00',
        submissionTotalSize: 0,
        courseId: 'fixture-course-1',
        gradableItemId: 'fixture-content-assignment-1',
        attemptId: 'fixture-attempt-completed',
        userId: 'fixture-user-1',
      },
    },
    inProgress: {
      id: 'fixture-attempt-draft',
      status: 'IN_PROGRESS',
      attemptReceipt: null,
      expected: 'unknown-with-in-progress',
    },
    unverifiedBoolean: {
      id: 'fixture-grade-boolean-only',
      submitted: true,
      expected: 'unknown-until-verified-attempt',
    },
  },
  calendarConflict: {
    id: 'fixture-calendar-column-1',
    type: 'GradebookColumn',
    courseId: 'fixture-course-1',
    columnId: 'fixture-column-1',
    start: '2026-10-20T23:59:00+08:00',
    end: '2026-10-21T00:59:00+08:00',
    expected: 'due-conflict-without-last-wins',
  },
  multiColumn: {
    contentId: 'fixture-content-assignment-1',
    columns: ['fixture-column-1', 'fixture-column-2'],
    expected: 'preserve-column-ids-and-stronger-submission-evidence',
  },
  accountSwitch: {
    beforeUserId: 'fixture-user-a',
    afterUserId: 'fixture-user-b',
    expected: 'discard-snapshot-and-cache-write',
  },
} as const;

export type ClassicApiRiskCaseName = keyof typeof CLASSIC_API_RISK_CASES;
