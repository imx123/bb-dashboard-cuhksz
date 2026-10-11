import { ClassicApiError } from './api-errors.js';
import { emptyRichBody, emptySubmissionSummary, RichBodySchema, SubmissionSummarySchema, type RichBody, type SubmissionSummary } from './schema-v2.js';
import { rawRecord, rawString } from './raw-schema.js';

/** Module-private provenance marker; a raw API field cannot forge this value. */
export const TRUSTED_FEEDBACK = Symbol('classic.submission.feedback.sanitized');

export interface SubmissionEvidenceInput {
  readonly status?: unknown;
  readonly attemptStatus?: unknown;
  readonly attemptId?: unknown;
  readonly latestAttemptId?: unknown;
  readonly confirmedSubmittedAttemptId?: unknown;
  readonly attemptCount?: unknown;
  readonly historyComplete?: unknown;
  readonly history?: readonly unknown[];
  readonly late?: unknown;
  readonly gradeDisplay?: unknown;
  readonly displayGrade?: unknown;
  readonly feedback?: unknown;
  readonly feedbackToUser?: unknown;
  /** Legacy compatibility field; it is deliberately ignored for trust. */
  readonly feedbackSanitized?: boolean;
  readonly [TRUSTED_FEEDBACK]?: true;
  readonly attemptReceipt?: unknown;
  readonly attempt?: unknown;
  readonly lastAttempt?: unknown;
}

export interface SubmissionDerivationOptions {
  /** Only a future, separately verified school mapping may set this. */
  readonly verifiedExplicitNone?: boolean;
}

export interface SubmissionScopeExpectation {
  readonly courseId: string;
  readonly userId?: string;
  readonly columnId?: string | null;
  readonly contentId?: string | null;
  readonly gradeId?: string | null;
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

function validCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  const match = DATE_TIME_PATTERN.exec(text);
  if (!match || !validCalendarDate(match[1]!, match[2]!, match[3]!) || !Number.isFinite(Date.parse(text))) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', `Blackboard 提交字段 ${field} 无法解释。`, { scope: 'submission' });
  }
  return text;
}

function idValue(value: unknown): string | null {
  const valueText = rawString(value);
  return valueText ? valueText.slice(0, 300) : null;
}

function statusValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function displayGradeText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  const item = rawRecord(value);
  if (!item) return null;
  return displayGradeText(item.score ?? item.value ?? item.displayValue ?? item.text);
}

/** Reject a submission/grade record that explicitly belongs to another scope. */
export function assertSubmissionScope(value: unknown, expected: SubmissionScopeExpectation): void {
  const root = rawRecord(value);
  if (!root) return;
  const allowedGradables = new Set([expected.columnId, expected.contentId].filter((item): item is string => !!item));
  const check = (item: Record<string, unknown>, scope: string): void => {
    const courseId = rawString(item.courseId);
    if (courseId && courseId !== expected.courseId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交记录课程归属不一致。', { scope });
    if (expected.userId) {
      const nestedUser = rawRecord(item.user);
      const userId = rawString(item.userId ?? nestedUser?.id ?? item.studentId);
      if (userId && userId !== expected.userId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交记录账号归属不一致。', { scope });
    }
    if (expected.columnId) {
      const nestedColumn = rawRecord(item.column);
      const columnId = rawString(item.columnId ?? nestedColumn?.columnId ?? nestedColumn?.id);
      if (columnId && columnId !== expected.columnId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交记录评分列归属不一致。', { scope });
    }
    if (expected.gradeId) {
      const gradeId = rawString(item.gradeId);
      if (gradeId && gradeId !== expected.gradeId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交记录成绩归属不一致。', { scope });
    }
    const gradableId = rawString(item.gradableItemId ?? item.contentId);
    if (gradableId && allowedGradables.size > 0 && !allowedGradables.has(gradableId)) {
      throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交记录作业归属不一致。', { scope });
    }
    const nestedReceipt = rawRecord(item.attemptReceipt);
    if (nestedReceipt) check(nestedReceipt, `${scope}.attemptReceipt`);
  };
  check(root, 'submission.scope');
  for (const [key, nested] of [['attempt', root.attempt], ['lastAttempt', root.lastAttempt], ['attemptReceipt', root.attemptReceipt]] as const) {
    const item = rawRecord(nested);
    if (item) check(item, `submission.scope.${key}`);
  }
  const attempt = rawRecord(root.lastAttempt ?? root.attempt);
  const attemptId = attempt ? rawString(attempt.id ?? attempt.attemptId) : null;
  const receipt = rawRecord(attempt?.attemptReceipt ?? root.attemptReceipt);
  const receiptAttemptId = rawString(receipt?.attemptId);
  if (attemptId && receiptAttemptId && attemptId !== receiptAttemptId) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交回执与 attempt 归属不一致。', { scope: 'submission.scope.attemptReceipt' });
  }
}

function attemptState(status: string): SubmissionSummary['latestAttemptState'] {
  // These are the only status values verified for CUHK(SZ) Classic. Every
  // other raw label stays unknown until the school mapping is confirmed.
  if (status === 'IN_PROGRESS') return 'in-progress';
  if (status === 'NEEDS_GRADING') return 'needs-grading';
  if (status === 'COMPLETED') return 'completed';
  return 'unknown';
}

function validRichBody(value: unknown, trusted: boolean): RichBody | null {
  const parsed = RichBodySchema.safeParse(value);
  // Raw API objects may contain a forged/ambiguous `complete` flag. Only the
  // normalizer's parser marker may preserve the parser's completeness result.
  if (!parsed.success) return null;
  if (trusted) return { ...parsed.data, complete: parsed.data.complete };
  // A renderer-facing sanitizedHtml/images/links object is never accepted
  // directly from the API. Preserve only its bounded plain text until the
  // mature parser has produced a trusted marker.
  return { text: parsed.data.text, sanitizedHtml: null, images: [], links: [], complete: false };
}

interface HistoricalSubmission {
  attemptId: string | null;
  receiptId: string | null;
  submittedAt: string | null;
  submissionTotalSize: number | null;
  evidence: 'receipt' | 'attempt-status';
}

function receiptEvidence(value: unknown): Omit<HistoricalSubmission, 'attemptId' | 'evidence'> & { valid: boolean } {
  const receipt = rawRecord(value);
  if (!receipt) return { valid: false, receiptId: null, submittedAt: null, submissionTotalSize: null };
  const receiptId = idValue(receipt.receiptId);
  const submittedAt = dateValue(receipt.submissionDate, 'attemptReceipt.submissionDate');
  const rawSize = receipt.submissionTotalSize;
  if (rawSize !== undefined && rawSize !== null && (typeof rawSize !== 'number' || !Number.isSafeInteger(rawSize) || rawSize < 0)) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 提交回执大小字段无法解释。', { scope: 'submission' });
  }
  const submissionTotalSize = typeof rawSize === 'number' ? rawSize : null;
  // A size of zero is still only receipt metadata. Without the investigated
  // receipt ID or submission date it cannot prove that a submission exists.
  return { valid: Boolean(receiptId || submittedAt), receiptId, submittedAt, submissionTotalSize };
}

function historyHasSubmitted(history: readonly unknown[] | undefined): HistoricalSubmission | null {
  let receiptEvidenceValue: HistoricalSubmission | null = null;
  let statusEvidence: HistoricalSubmission | null = null;
  for (const entry of history ?? []) {
    const item = rawRecord(entry);
    if (!item) continue;
    const status = statusValue(item.status ?? item.attemptStatus);
    const nestedAttempt = rawRecord(item.lastAttempt ?? item.attempt);
    const receiptValue = item.attemptReceipt ?? nestedAttempt?.attemptReceipt;
    const receipt = receiptEvidence(receiptValue);
    if (receipt.valid) {
      const receiptObject = rawRecord(receiptValue);
      const candidate: HistoricalSubmission = {
        // Prefer the receipt's own attempt binding. A history wrapper may
        // carry a grade-row id that is unrelated to the attempt being proven.
        attemptId: idValue(receiptObject?.attemptId ?? nestedAttempt?.id ?? nestedAttempt?.attemptId ?? item.attemptId ?? item.id),
        receiptId: receipt.receiptId,
        submittedAt: receipt.submittedAt,
        submissionTotalSize: receipt.submissionTotalSize,
        evidence: 'receipt',
      };
      if (!receiptEvidenceValue ||
          (candidate.submittedAt && (!receiptEvidenceValue.submittedAt || Date.parse(candidate.submittedAt) >= Date.parse(receiptEvidenceValue.submittedAt))) ||
          (!candidate.submittedAt && !receiptEvidenceValue.submittedAt)) {
        receiptEvidenceValue = candidate;
      }
    }
    if (['NEEDS_GRADING', 'COMPLETED'].includes(status)) {
      statusEvidence ??= { attemptId: idValue(nestedAttempt?.id ?? nestedAttempt?.attemptId ?? item.attemptId ?? item.id), receiptId: null, submittedAt: null, submissionTotalSize: null, evidence: 'attempt-status' };
    }
  }
  return receiptEvidenceValue ?? statusEvidence;
}

/**
 * Convert only explicit receipt/verified attempt evidence. An attempt id,
 * attemptDate, grade, or arbitrary raw boolean never becomes a submission
 * state. A future trusted adapter may opt into verifiedExplicitNone.
 */
export function deriveSubmissionSummary(input: SubmissionEvidenceInput | unknown, options: SubmissionDerivationOptions = {}): SubmissionSummary {
  const value = (rawRecord(input) ?? {}) as SubmissionEvidenceInput;
  const attempt = rawRecord(value.lastAttempt ?? value.attempt);
  // The investigated Classic payload nests the only verified receipt metadata
  // under attemptReceipt. Generic top-level booleans, dates, IDs, or `receipt`
  // objects are deliberately ignored until a separately verified adapter maps
  // them into this shape.
  const topReceiptValue = value.attemptReceipt;
  const topReceipt = receiptEvidence(topReceiptValue);
  const receiptValue = topReceipt.valid ? topReceiptValue : attempt?.attemptReceipt;
  const receipt = topReceipt.valid ? topReceipt : receiptEvidence(receiptValue);
  // `status` on a grade can describe the grade row itself. The investigated
  // payload exposes the submission state under lastAttempt/attempt, so that
  // nested state always wins when present.
  const status = statusValue(attempt?.status ?? attempt?.attemptStatus ?? value.status ?? value.attemptStatus);
  const historyComplete = value.historyComplete === true;
  if (value.attemptCount !== undefined && value.attemptCount !== null &&
      (typeof value.attemptCount !== 'number' || !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 0)) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard attempt 数量字段无法解释。', { scope: 'submission' });
  }
  const historySubmitted = historyHasSubmitted(value.history);
  const hasReceipt = receipt.valid;
  const receiptHistory = !hasReceipt && historySubmitted?.evidence === 'receipt' ? historySubmitted : null;
  const confirmedReceipt = hasReceipt ? receipt : receiptHistory;
  const hasMetadata = (item: Omit<HistoricalSubmission, 'attemptId' | 'evidence'>): boolean => Boolean(item.receiptId || item.submittedAt || item.submissionTotalSize !== null);
  const nestedReceipt = !topReceipt.valid ? receipt : null;
  const receiptMetadata = hasReceipt
    ? receipt
    : nestedReceipt && hasMetadata(nestedReceipt) ? nestedReceipt : topReceipt;
  const receiptId = confirmedReceipt?.receiptId ?? null;
  const submittedAt = confirmedReceipt?.submittedAt ?? null;
  // Preserve a size field as metadata even when it is insufficient evidence
  // on its own; it must not affect remoteSubmission or confirmation IDs.
  const submissionTotalSize = confirmedReceipt?.submissionTotalSize ?? receiptMetadata.submissionTotalSize ?? null;
  const receiptObject = rawRecord(receiptValue);
  const latestAttemptId = idValue(value.latestAttemptId ?? attempt?.id ?? attempt?.attemptId ?? receiptObject?.attemptId);
  const receiptAttemptId = idValue(receiptObject?.attemptId);
  const confirmedSubmittedAttemptId = hasReceipt
    ? receiptAttemptId
    : receiptHistory?.attemptId ?? (['NEEDS_GRADING', 'COMPLETED'].includes(status) ? latestAttemptId : historySubmitted?.attemptId ?? null);
  const feedbackValue = value.feedback ?? value.feedbackToUser ?? attempt?.feedbackToUser;

  let remoteSubmission: SubmissionSummary['remoteSubmission'] = 'unknown';
  let evidence: SubmissionSummary['evidence'] = 'unknown';
  if (hasReceipt) {
    remoteSubmission = 'submitted'; evidence = 'receipt';
  } else if (receiptHistory) {
    remoteSubmission = 'submitted'; evidence = 'receipt';
  } else if (['NEEDS_GRADING', 'COMPLETED'].includes(status)) {
    remoteSubmission = 'submitted'; evidence = 'attempt-status';
  } else if (historySubmitted) {
    remoteSubmission = 'submitted'; evidence = historySubmitted.evidence;
  } else if (options.verifiedExplicitNone === true) {
    remoteSubmission = 'not-submitted'; evidence = 'explicit-none';
  }
  const output = {
    ...emptySubmissionSummary(),
    remoteSubmission,
    latestAttemptState: attemptState(status),
    rawAttemptStatus: status || null,
    submittedAt,
    receiptId,
    submissionTotalSize,
    latestAttemptId,
    confirmedSubmittedAttemptId,
    attemptCount: historyComplete && typeof value.attemptCount === 'number' ? value.attemptCount : null,
    historyComplete,
    evidence,
    late: typeof value.late === 'boolean' ? value.late : null,
    gradeDisplay: displayGradeText(value.gradeDisplay ?? value.displayGrade ?? attempt?.displayGrade),
    feedback: validRichBody(feedbackValue, value[TRUSTED_FEEDBACK] === true) ?? (typeof feedbackValue === 'string' ? emptyRichBody(feedbackValue, false) : null),
  } satisfies SubmissionSummary;
  return SubmissionSummarySchema.parse(output);
}

function evidenceRank(summary: SubmissionSummary): number {
  if (summary.evidence === 'receipt') return 3;
  if (summary.evidence === 'attempt-status') return 2;
  if (summary.evidence === 'explicit-none') return 1;
  return 0;
}

/** Merge one-to-many grade-column evidence without letting unknown overwrite proof. */
export function mergeSubmissionSummaries(left: SubmissionSummary, right: SubmissionSummary): { summary: SubmissionSummary; conflict: boolean } {
  const leftRank = evidenceRank(left);
  const rightRank = evidenceRank(right);
  const submittedConflict = left.remoteSubmission === 'submitted' && right.remoteSubmission === 'submitted' && (
    (!!left.submittedAt && !!right.submittedAt && left.submittedAt !== right.submittedAt) ||
    (!!left.receiptId && !!right.receiptId && left.receiptId !== right.receiptId)
  );
  const selected = rightRank > leftRank ? right : left;
  const secondary = selected === right ? left : right;
  const merged = SubmissionSummarySchema.parse({
    ...selected,
    latestAttemptId: selected.latestAttemptId ?? secondary.latestAttemptId,
    confirmedSubmittedAttemptId: selected.confirmedSubmittedAttemptId ?? secondary.confirmedSubmittedAttemptId,
    attemptCount: selected.attemptCount ?? secondary.attemptCount,
    historyComplete: selected.historyComplete && secondary.historyComplete,
    gradeDisplay: selected.gradeDisplay ?? secondary.gradeDisplay,
    feedback: selected.feedback ?? secondary.feedback,
  });
  return { summary: merged, conflict: submittedConflict };
}
