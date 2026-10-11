import { z } from 'zod';

/**
 * Versioned domain contract for the JSON Classic reader.
 *
 * The existing `schema.ts` remains the v1 MCP compatibility contract until
 * the Provider switch.  New API code must validate its output here before it
 * can cross the main-process boundary.
 */

const Id = z.string().trim().min(1).max(300);
const Text = z.string().max(500_000);
function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return false;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
const DateTime = z.string().trim().min(1).max(100)
  .refine(value => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value), 'Expected a date-time with a time component')
  .refine(value => validCalendarDate(value) && Number.isFinite(Date.parse(value)), 'Expected a valid calendar date-time');
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine(validCalendarDate, 'Expected a valid calendar date');
const Url = z.string().url().max(4096);

export const FetchStateV2Schema = z.enum(['ok', 'partial', 'error', 'auth-required']);
export type FetchStateV2 = z.infer<typeof FetchStateV2Schema>;

export const EvidenceV2Schema = z.enum(['blackboard-field', 'page-text', 'user-entered', 'unknown']);
export type EvidenceV2 = z.infer<typeof EvidenceV2Schema>;

export const CoverageStateSchema = z.enum(['complete', 'partial', 'unsupported', 'failed']);
export type CoverageState = z.infer<typeof CoverageStateSchema>;

export const RemoteSubmissionV2Schema = z.enum(['submitted', 'not-submitted', 'unknown']);
export type RemoteSubmissionV2 = z.infer<typeof RemoteSubmissionV2Schema>;

export const AttemptStateSchema = z.enum(['in-progress', 'needs-grading', 'completed', 'unknown']);
export type AttemptState = z.infer<typeof AttemptStateSchema>;

export const ProvenanceSourceSchema = z.enum(['internal-api', 'public-api', 'html-detail', 'user-entered']);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const ProvenanceSchema = z.object({
  source: ProvenanceSourceSchema,
  fetchedAt: DateTime,
  stale: z.boolean(),
}).strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CourseV2Schema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(500),
  code: z.string().trim().max(200).nullable(),
  url: Url.nullable(),
  available: z.boolean().optional(),
}).strict();
export type CourseV2 = z.infer<typeof CourseV2Schema>;

export const RichImageSchema = z.object({
  resourceId: Id,
  alt: z.string().max(500).nullable(),
}).strict();
export type RichImage = z.infer<typeof RichImageSchema>;

export const RichLinkSchema = z.object({
  label: z.string().max(2_000),
  url: Url.nullable(),
}).strict();
export type RichLink = z.infer<typeof RichLinkSchema>;

export const RichBodySchema = z.object({
  text: Text,
  sanitizedHtml: Text.nullable(),
  images: z.array(RichImageSchema).max(500),
  links: z.array(RichLinkSchema).max(500),
  complete: z.boolean(),
}).strict();
export type RichBody = z.infer<typeof RichBodySchema>;

export const AttachmentV2Schema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().max(200).nullable(),
  url: Url.nullable(),
  resourceId: Id.nullable(),
}).strict();
export type AttachmentV2 = z.infer<typeof AttachmentV2Schema>;

export const AnnouncementV2Schema = z.object({
  id: Id,
  courseId: Id,
  title: z.string().trim().min(1).max(500),
  body: RichBodySchema,
  createdAt: DateTime.nullable(),
  modifiedAt: DateTime.nullable(),
  visibleFrom: DateTime.nullable(),
  visibleUntil: DateTime.nullable(),
  publishedAt: DateTime.nullable(),
  unread: z.boolean().nullable(),
  localSeenAt: DateTime.nullable(),
  url: Url.nullable(),
  provenance: ProvenanceSchema,
}).strict();
export type AnnouncementV2 = z.infer<typeof AnnouncementV2Schema>;

export const SubmissionEvidenceSchema = z.enum(['receipt', 'attempt-status', 'explicit-none', 'unknown']);
export type SubmissionEvidence = z.infer<typeof SubmissionEvidenceSchema>;

export const SubmissionSummarySchema = z.object({
  remoteSubmission: RemoteSubmissionV2Schema,
  latestAttemptState: AttemptStateSchema,
  rawAttemptStatus: z.string().trim().max(200).nullable(),
  submittedAt: DateTime.nullable(),
  receiptId: Id.nullable(),
  submissionTotalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  latestAttemptId: Id.nullable(),
  confirmedSubmittedAttemptId: Id.nullable(),
  attemptCount: z.number().int().nonnegative().max(100_000).nullable(),
  historyComplete: z.boolean(),
  evidence: SubmissionEvidenceSchema,
  late: z.boolean().nullable(),
  gradeDisplay: z.string().max(2_000).nullable(),
  feedback: RichBodySchema.nullable(),
}).strict();
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;

export const AssignmentKindSchema = z.enum(['assignment', 'test', 'other-graded', 'unknown']);
export type AssignmentKind = z.infer<typeof AssignmentKindSchema>;

export const PersonalDueStateSchema = z.enum(['confirmed', 'unverified']);
export type PersonalDueState = z.infer<typeof PersonalDueStateSchema>;

export const AssignmentV2Schema = z.object({
  id: Id,
  courseId: Id,
  contentId: Id.nullable(),
  columnId: Id.nullable(),
  kind: AssignmentKindSchema,
  title: z.string().trim().min(1).max(500),
  dueAt: DateTime.nullable(),
  dueDateOnly: DateOnly.nullable(),
  dueEvidence: EvidenceV2Schema,
  standardDueAt: DateTime.nullable(),
  personalDueAt: DateTime.nullable(),
  personalDueState: PersonalDueStateSchema,
  dueConflict: z.boolean(),
  url: Url.nullable(),
  summary: Text.nullable(),
  details: RichBodySchema.nullable(),
  attachments: z.array(AttachmentV2Schema).max(500),
  submission: SubmissionSummarySchema,
  manualCompleted: z.boolean().optional(),
  provenance: ProvenanceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.dueAt !== null && value.dueDateOnly !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDateOnly'], message: 'dueAt and dueDateOnly are mutually exclusive.' });
  }
});
export type AssignmentV2 = z.infer<typeof AssignmentV2Schema>;

export const CourseFileKindSchema = z.enum(['file', 'document', 'external-link', 'video', 'unknown']);
export type CourseFileKind = z.infer<typeof CourseFileKindSchema>;

export const CourseFileV2Schema = z.object({
  id: Id,
  courseId: Id,
  contentId: Id,
  name: z.string().trim().min(1).max(500),
  kind: CourseFileKindSchema,
  url: Url.nullable(),
  createdAt: DateTime.nullable(),
  modifiedAt: DateTime.nullable(),
  publishedAt: DateTime.nullable(),
  mimeType: z.string().trim().max(200).nullable(),
  attachments: z.array(AttachmentV2Schema).max(500),
  provenance: ProvenanceSchema,
}).strict();
export type CourseFileV2 = z.infer<typeof CourseFileV2Schema>;

export const CoverageResourceSchema = z.enum(['courses', 'announcements', 'contents', 'assignments', 'grades', 'files', 'calendar']);
export type CoverageResource = z.infer<typeof CoverageResourceSchema>;

export const CoverageEntrySchema = z.object({
  courseId: Id.nullable(),
  resource: CoverageResourceSchema,
  state: CoverageStateSchema,
  received: z.number().int().nonnegative().max(1_000_000),
  pages: z.number().int().nonnegative().max(100_000),
  truncated: z.boolean(),
  restrictedNodes: z.number().int().nonnegative().max(1_000_000),
  checkedAt: DateTime,
}).strict();
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

export const SnapshotErrorV2Schema = z.object({
  scope: z.string().trim().min(1).max(300),
  code: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1_000),
}).strict();
export type SnapshotErrorV2 = z.infer<typeof SnapshotErrorV2Schema>;

export const SnapshotV2Schema = z.object({
  schemaVersion: z.literal(2),
  state: FetchStateV2Schema,
  fetchedAt: DateTime,
  timezone: z.literal('Asia/Shanghai'),
  source: z.enum(['live', 'offline-fixture']),
  courses: z.array(CourseV2Schema).max(500),
  announcements: z.array(AnnouncementV2Schema).max(100_000),
  assignments: z.array(AssignmentV2Schema).max(100_000),
  files: z.array(CourseFileV2Schema).max(100_000),
  coverage: z.array(CoverageEntrySchema).max(10_000),
  errors: z.array(SnapshotErrorV2Schema).max(10_000),
}).strict();
export type SnapshotV2 = z.infer<typeof SnapshotV2Schema>;

export function parseSnapshotV2(value: unknown): SnapshotV2 {
  return SnapshotV2Schema.parse(value);
}

export function emptyRichBody(text = '', complete = false): RichBody {
  return { text, sanitizedHtml: null, images: [], links: [], complete };
}

export function emptySubmissionSummary(): SubmissionSummary {
  return {
    remoteSubmission: 'unknown',
    latestAttemptState: 'unknown',
    rawAttemptStatus: null,
    submittedAt: null,
    receiptId: null,
    submissionTotalSize: null,
    latestAttemptId: null,
    confirmedSubmittedAttemptId: null,
    attemptCount: null,
    historyComplete: false,
    evidence: 'unknown',
    late: null,
    gradeDisplay: null,
    feedback: null,
  };
}
