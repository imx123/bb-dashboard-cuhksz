import { z } from 'zod';
import { ClassicApiError } from './api-errors.js';

const RawText = z.string().max(500_000);
const RawId = z.union([
  z.string().trim().min(1).max(300),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String),
]);

/** Fields observed under Classic grade/attempt `attemptReceipt`. */
const RawAttemptReceiptSchema = z.object({
  receiptId: RawId.nullable().optional(),
  submissionDate: RawText.nullable().optional(),
  submissionTotalSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  courseId: RawId.nullable().optional(),
  gradableItemId: RawId.nullable().optional(),
  attemptId: RawId.nullable().optional(),
  userId: RawId.nullable().optional(),
}).passthrough();

export const RawPagingSchema = z.object({
  // Paginator validates the fixed origin. The API may return an empty or
  // relative link, so the lowest raw schema must not require an absolute URL.
  nextPage: z.string().trim().max(4096).nullable().optional(),
  next: z.string().trim().max(4096).nullable().optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
}).passthrough();
export type RawPaging = z.infer<typeof RawPagingSchema>;

const rawEntityShape = {
  id: RawId.optional(),
  courseId: RawId.optional(),
  contentId: RawId.optional(),
  announcementId: RawId.optional(),
  assignmentId: RawId.optional(),
  columnId: RawId.optional(),
  gradeId: RawId.optional(),
  attemptId: RawId.optional(),
  attachmentId: RawId.optional(),
};

function requireEntityId(label: string, keys: readonly string[]) {
  return (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
    const found = keys.some(key => {
      const item = value[key];
      return (typeof item === 'string' && item.trim().length > 0) || (typeof item === 'number' && Number.isSafeInteger(item));
    });
    if (!found) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must contain an identifier.` });
  };
}

function requireCalendarRowContext(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const hasContext = ['calendarId'].some(key => {
    const item = value[key];
    return (typeof item === 'string' && item.trim().length > 0) || (typeof item === 'number' && Number.isSafeInteger(item));
  });
  const hasExplicitItemId = ['id', 'calendarItemId', 'eventId'].some(key => {
    const item = value[key];
    return (typeof item === 'string' && item.trim().length > 0) || (typeof item === 'number' && Number.isSafeInteger(item));
  });
  if (!hasContext && !hasExplicitItemId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Calendar row lacks a verified context or explicit item identifier.' });
  }
}

export const RawCourseSchema = z.object({
  ...rawEntityShape,
  name: RawText.nullable().optional(),
  title: RawText.nullable().optional(),
  code: RawText.nullable().optional(),
  courseCode: RawText.nullable().optional(),
  url: z.string().max(4096).nullable().optional(),
  availability: z.unknown().optional(),
}).passthrough().superRefine(requireEntityId('course', ['id', 'courseId']));
export type RawCourse = z.infer<typeof RawCourseSchema>;

export const RawAnnouncementSchema = z.object({
  ...rawEntityShape,
  title: RawText.nullable().optional(),
  subject: RawText.nullable().optional(),
  body: z.union([RawText, z.record(z.unknown())]).nullable().optional(),
  displayText: RawText.nullable().optional(),
  rawText: RawText.nullable().optional(),
  createdDate: RawText.nullable().optional(),
  createdAt: RawText.nullable().optional(),
  modifiedDate: RawText.nullable().optional(),
  modifiedAt: RawText.nullable().optional(),
  startDateRestriction: RawText.nullable().optional(),
  endDateRestriction: RawText.nullable().optional(),
  startDate: RawText.nullable().optional(),
  endDate: RawText.nullable().optional(),
  publishedAt: RawText.nullable().optional(),
  unread: z.boolean().optional(),
  url: z.string().max(4096).nullable().optional(),
}).passthrough().superRefine(requireEntityId('announcement', ['id', 'announcementId']));
export type RawAnnouncement = z.infer<typeof RawAnnouncementSchema>;

export const RawContentNodeSchema = z.object({
  ...rawEntityShape,
  title: RawText.nullable().optional(),
  name: RawText.nullable().optional(),
  description: z.union([RawText, z.record(z.unknown())]).nullable().optional(),
  contentHandler: z.unknown().optional(),
  hasChildren: z.boolean().optional(),
  availability: z.unknown().optional(),
  url: z.string().max(4096).nullable().optional(),
  attachments: z.array(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('content node', ['id', 'contentId']));
export type RawContentNode = z.infer<typeof RawContentNodeSchema>;

export const RawGradeColumnSchema = z.object({
  ...rawEntityShape,
  title: RawText.nullable().optional(),
  name: RawText.nullable().optional(),
  due: RawText.nullable().optional(),
  dueDate: RawText.nullable().optional(),
  grading: z.record(z.unknown()).nullable().optional(),
}).passthrough().superRefine(requireEntityId('grade column', ['id', 'columnId']));
export type RawGradeColumn = z.infer<typeof RawGradeColumnSchema>;

export const RawGradeSchema = z.object({
  ...rawEntityShape,
  // The observed collection shape has rows with id=null while gradeId is
  // missing, with columnId and userId still present. Preserve that shape
  // without inferring why the grade identifier is absent or treating the
  // column identifier as a grade identifier.
  id: RawId.nullable().optional(),
  gradeId: RawId.nullable().optional(),
  status: RawText.nullable().optional(),
  attemptStatus: RawText.nullable().optional(),
  submitted: z.boolean().nullable().optional(),
  submittedAt: RawText.nullable().optional(),
  attemptDate: RawText.nullable().optional(),
  attemptReceipt: RawAttemptReceiptSchema.nullable().optional(),
  lastAttempt: z.record(z.unknown()).nullable().optional(),
  receipt: z.record(z.unknown()).nullable().optional(),
  attempt: z.record(z.unknown()).nullable().optional(),
}).passthrough().superRefine(requireEntityId('grade', ['id', 'gradeId', 'columnId']));
export type RawGrade = z.infer<typeof RawGradeSchema>;

export const RawAttemptSchema = z.object({
  ...rawEntityShape,
  status: RawText.nullable().optional(),
  submittedAt: RawText.nullable().optional(),
  attemptDate: RawText.nullable().optional(),
  attemptReceipt: RawAttemptReceiptSchema.nullable().optional(),
  receipt: z.record(z.unknown()).nullable().optional(),
}).passthrough().superRefine(requireEntityId('attempt', ['id', 'attemptId']));
export type RawAttempt = z.infer<typeof RawAttemptSchema>;

/** Fields observed in the internal calendarItems collection. */
export const RawCalendarItemSchema = z.object({
  ...rawEntityShape,
  // The observed internal calendarItems rows use calendarId while id is
  // missing. Keep the item for coverage, but do not infer its course or task
  // association from this identifier.
  id: RawId.nullable().optional(),
  calendarItemId: RawId.nullable().optional(),
  eventId: RawId.nullable().optional(),
  calendarId: RawId.nullable().optional(),
  type: RawText.nullable().optional(),
  title: RawText.nullable().optional(),
  description: z.union([RawText, z.record(z.unknown())]).nullable().optional(),
  start: RawText.nullable().optional(),
  end: RawText.nullable().optional(),
  modified: RawText.nullable().optional(),
  dynamicCalendarItemProps: z.record(z.unknown()).nullable().optional(),
}).passthrough().superRefine(requireCalendarRowContext);
export type RawCalendarItem = z.infer<typeof RawCalendarItemSchema>;

export const RawFileSchema = z.object({
  ...rawEntityShape,
  name: RawText.nullable().optional(),
  title: RawText.nullable().optional(),
  fileName: RawText.nullable().optional(),
  mimeType: RawText.nullable().optional(),
  url: z.string().max(4096).nullable().optional(),
  createdAt: RawText.nullable().optional(),
  modifiedAt: RawText.nullable().optional(),
  created: RawText.nullable().optional(),
  modified: RawText.nullable().optional(),
  publishedAt: RawText.nullable().optional(),
  attachments: z.array(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('file', ['id', 'attachmentId', 'contentId']));
export type RawFile = z.infer<typeof RawFileSchema>;

export const RawCollectionSchema = z.object({
  results: z.array(z.unknown()).optional(),
  items: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
  paging: RawPagingSchema.nullable().optional(),
}).passthrough().superRefine((value, ctx) => {
  if (!value.results && !value.items && !value.data) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Collection response must contain a results/items/data array.' });
});
export type RawCollection = z.infer<typeof RawCollectionSchema>;

export const RawObjectSchema = z.record(z.unknown());
export type RawObject = z.infer<typeof RawObjectSchema>;

export function parseRawCollection(value: unknown, scope: string): RawCollection {
  const parsed = RawCollectionSchema.safeParse(value);
  if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 返回的集合结构无法识别。', { scope, cause: parsed.error });
  return parsed.data;
}

export function collectionItems(value: RawCollection): unknown[] {
  return value.results ?? value.items ?? value.data ?? [];
}

export function rawString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function rawId(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = rawString(value[key]);
    if (found) return found;
  }
  return undefined;
}

export function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function rawArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
