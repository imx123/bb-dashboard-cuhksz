import { z } from 'zod';

/** Evidence attached to a value read from Classic.  Unknown is deliberate: a
 * missing field must never be turned into a guessed value by the adapter. */
export const EvidenceSchema = z.enum(['blackboard-field', 'page-text', 'user-entered', 'unknown']);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FetchStateSchema = z.enum(['ok', 'partial', 'error', 'auth-required']);
export type FetchState = z.infer<typeof FetchStateSchema>;

const Id = z.string().trim().min(1).max(300);
const Url = z.string().url().max(2048);
const DateTime = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Expected a parseable date-time');
const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const CourseSchema = z.object({
  id: Id,
  name: z.string().trim().min(1).max(500),
  code: z.string().trim().max(200).nullable().default(null),
  url: Url.nullable().default(null),
  available: z.boolean().optional(),
}).strict();
export type Course = z.infer<typeof CourseSchema>;

export const RemoteSubmissionSchema = z.enum(['submitted', 'not-submitted', 'unknown']);
export type RemoteSubmission = z.infer<typeof RemoteSubmissionSchema>;

export const AssignmentSchema = z.object({
  id: Id,
  courseId: Id,
  title: z.string().trim().min(1).max(500),
  dueAt: DateTime.nullable(),
  dueDateOnly: DateOnly.nullable().default(null),
  dueEvidence: EvidenceSchema,
  url: Url.nullable().default(null),
  remoteSubmission: RemoteSubmissionSchema,
  manualCompleted: z.boolean().optional(),
  summary: z.string().max(100_000).nullable().default(null),
  attachments: z.array(z.object({ name: z.string().trim().min(1).max(500), url: Url.nullable().default(null) }).strict()).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.dueAt !== null && value.dueDateOnly !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDateOnly'], message: 'A task cannot contain both dueAt and dueDateOnly.' });
  }
});
export type Assignment = z.infer<typeof AssignmentSchema>;

export const AnnouncementSchema = z.object({
  id: Id,
  courseId: Id,
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  publishedAt: DateTime.nullable(),
  url: Url.nullable().default(null),
  unread: z.boolean().nullable(),
}).strict();
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const CourseFileSchema = z.object({
  id: Id,
  courseId: Id,
  name: z.string().trim().min(1).max(500),
  url: Url.nullable().default(null),
  publishedAt: DateTime.nullable(),
}).strict();
export type CourseFile = z.infer<typeof CourseFileSchema>;

export const SnapshotErrorSchema = z.object({
  scope: z.string().trim().min(1).max(200),
  code: z.string().trim().min(1).max(100),
  message: z.string().trim().min(1).max(1000),
}).strict();
export type SnapshotError = z.infer<typeof SnapshotErrorSchema>;

/** Safe, bounded diagnostics from the local Classic auth check.  It contains
 * only an allowlisted origin/path and DOM shape counts; it never carries
 * query strings, page text, account identifiers, cookies, or screenshots. */
export const AuthResultSchema = z.object({
  phase: z.enum(['current-page', 'candidate']),
  origin: z.literal('https://bb.cuhk.edu.cn').nullable(),
  pathname: z.string().regex(/^\/[^?#]*$/, 'Expected a path without query or fragment').max(2048).nullable(),
  portalTarget: z.string().regex(/^\/[^?#]*$/, 'Expected a path without query or fragment').max(2048).nullable(),
  portalCandidate: z.boolean(),
  courseLinkCount: z.number().int().min(0).max(200),
  marker: z.boolean(),
  iframeCount: z.number().int().min(0).max(200),
  explicitLoginForm: z.boolean(),
  sessionExpired: z.boolean().default(false),
}).strict();
export type AuthResult = z.infer<typeof AuthResultSchema>;

export const SnapshotSchema = z.object({
  state: FetchStateSchema,
  fetchedAt: DateTime,
  timezone: z.literal('Asia/Shanghai'),
  courses: z.array(CourseSchema),
  announcements: z.array(AnnouncementSchema),
  assignments: z.array(AssignmentSchema),
  files: z.array(CourseFileSchema),
  errors: z.array(SnapshotErrorSchema),
  /** UI-visible provenance. Offline data is never presented as a live read. */
  source: z.enum(['live', 'offline-fixture']).optional(),
}).strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ClassicToolNameSchema = z.enum([
  'classic_status',
  'classic_login',
  'classic_snapshot',
  'classic_list_courses',
  'classic_announcements',
  'classic_list_assignments',
  'classic_assignment_details',
  'classic_list_course_files',
]);
export type ClassicToolName = z.infer<typeof ClassicToolNameSchema>;

export function parseSnapshot(value: unknown): Snapshot {
  return SnapshotSchema.parse(value);
}
