import { ClassicApiError } from './api-errors.js';
import { emptyRichBody, emptySubmissionSummary, RichBodySchema, SubmissionSummarySchema, type RichBody, type SubmissionSummary } from './schema-v2.js';
import { rawRecord, rawString } from './raw-schema.js';

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
  readonly feedback?: unknown;
  readonly attemptReceipt?: unknown;
  readonly attempt?: unknown;
  readonly lastAttempt?: unknown;
}

export interface SubmissionDerivationOptions {
  /** Only a future, separately verified school mapping may set this. */
  readonly verifiedExplicitNone?: boolean;
}

const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function validCalendarDate(yearText: string, monthText: string, dayText: string): boolean {
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  const match = DATE_TIME_PATTERN.exec(text);
  if (!match || !validCalendarDate(match[1], match[2], match[3]) || !Number.isFinite(Date.parse(text))) {
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

function attemptState(status: string): SubmissionSummary['latestAttemptState'] {
  // These are the only status values verified for CUHK(SZ) Classic. Every
  // other raw label stays unknown until the school mapping is confirmed.
  if (status === 'IN_PROGRESS') return 'in-progress';
  if (status === 'NEEDS_GRADING') return 'needs-grading';
  if (status === 'COMPLETED') return 'completed';
  return 'unknown';
}

function validRichBody(value: unknown): RichBody | null {
  const parsed = RichBodySchema.safeParse(value);
  // No rich-text parser is wired into M0. Even a raw object that happens to
  // contain `complete: true` is not trusted as a complete school response.
  return parsed.success ? { ...parsed.data, complete: false } : null;
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
  let statusEvidence: HistoricalSubmission | null = null;
  for (const entry of history ?? []) {
    const item = rawRecord(entry);
    if (!item) continue;
    const status = statusValue(item.status ?? item.attemptStatus);
    const receiptValue = item.attemptReceipt;
    const receipt = receiptEvidence(receiptValue);
    if (receipt.valid) {
      const receiptObject = rawRecord(receiptValue);
      return {
        attemptId: idValue(item.id ?? item.attemptId ?? receiptObject?.attemptId),
        receiptId: receipt.receiptId,
        submittedAt: receipt.submittedAt,
        submissionTotalSize: receipt.submissionTotalSize,
        evidence: 'receipt',
      };
    }
    if (['NEEDS_GRADING', 'COMPLETED'].includes(status)) {
      statusEvidence ??= { attemptId: idValue(item.id ?? item.attemptId), receiptId: null, submittedAt: null, submissionTotalSize: null, evidence: 'attempt-status' };
    }
  }
  return statusEvidence;
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
  const latestAttemptId = idValue(value.latestAttemptId ?? value.attemptId ?? attempt?.id ?? attempt?.attemptId ?? receiptObject?.attemptId);
  const receiptAttemptId = idValue(receiptObject?.attemptId);
  const confirmedSubmittedAttemptId = hasReceipt
    ? receiptAttemptId ?? latestAttemptId
    : receiptHistory?.attemptId ?? (['NEEDS_GRADING', 'COMPLETED'].includes(status) ? latestAttemptId : historySubmitted?.attemptId ?? null);

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
    gradeDisplay: typeof value.gradeDisplay === 'string' ? value.gradeDisplay : null,
    feedback: validRichBody(value.feedback) ?? (typeof value.feedback === 'string' ? emptyRichBody(value.feedback, false) : null),
  } satisfies SubmissionSummary;
  return SubmissionSummarySchema.parse(output);
}
