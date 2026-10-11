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

export const RawCourseSchema = z.object({
  ...rawEntityShape,
  name: RawText.optional(),
  title: RawText.optional(),
  code: RawText.optional(),
  courseCode: RawText.optional(),
  url: z.string().max(4096).optional(),
  availability: z.unknown().optional(),
}).passthrough().superRefine(requireEntityId('course', ['id', 'courseId']));
export type RawCourse = z.infer<typeof RawCourseSchema>;

export const RawAnnouncementSchema = z.object({
  ...rawEntityShape,
  title: RawText.optional(),
  subject: RawText.optional(),
  body: z.union([RawText, z.record(z.unknown())]).optional(),
  displayText: RawText.optional(),
  rawText: RawText.optional(),
  createdDate: RawText.optional(),
  createdAt: RawText.optional(),
  modifiedDate: RawText.optional(),
  modifiedAt: RawText.optional(),
  startDateRestriction: RawText.optional(),
  endDateRestriction: RawText.optional(),
  startDate: RawText.optional(),
  endDate: RawText.optional(),
  publishedAt: RawText.optional(),
  unread: z.boolean().optional(),
  url: z.string().max(4096).optional(),
}).passthrough().superRefine(requireEntityId('announcement', ['id', 'announcementId']));
export type RawAnnouncement = z.infer<typeof RawAnnouncementSchema>;

export const RawContentNodeSchema = z.object({
  ...rawEntityShape,
  title: RawText.optional(),
  name: RawText.optional(),
  description: z.union([RawText, z.record(z.unknown())]).optional(),
  contentHandler: z.unknown().optional(),
  hasChildren: z.boolean().optional(),
  availability: z.unknown().optional(),
  url: z.string().max(4096).optional(),
  attachments: z.array(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('content node', ['id', 'contentId']));
export type RawContentNode = z.infer<typeof RawContentNodeSchema>;

export const RawGradeColumnSchema = z.object({
  ...rawEntityShape,
  title: RawText.optional(),
  name: RawText.optional(),
  due: RawText.nullable().optional(),
  dueDate: RawText.nullable().optional(),
  grading: z.record(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('grade column', ['id', 'columnId']));
export type RawGradeColumn = z.infer<typeof RawGradeColumnSchema>;

export const RawGradeSchema = z.object({
  ...rawEntityShape,
  status: RawText.optional(),
  attemptStatus: RawText.optional(),
  submitted: z.boolean().optional(),
  submittedAt: RawText.optional(),
  attemptDate: RawText.optional(),
  attemptReceipt: RawAttemptReceiptSchema.nullable().optional(),
  lastAttempt: z.record(z.unknown()).optional(),
  receipt: z.record(z.unknown()).optional(),
  attempt: z.record(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('grade', ['id', 'gradeId']));
export type RawGrade = z.infer<typeof RawGradeSchema>;

export const RawAttemptSchema = z.object({
  ...rawEntityShape,
  status: RawText.optional(),
  submittedAt: RawText.optional(),
  attemptDate: RawText.optional(),
  attemptReceipt: RawAttemptReceiptSchema.nullable().optional(),
  receipt: z.record(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('attempt', ['id', 'attemptId']));
export type RawAttempt = z.infer<typeof RawAttemptSchema>;

export const RawFileSchema = z.object({
  ...rawEntityShape,
  name: RawText.optional(),
  title: RawText.optional(),
  fileName: RawText.optional(),
  mimeType: RawText.optional(),
  url: z.string().max(4096).optional(),
  createdAt: RawText.optional(),
  modifiedAt: RawText.optional(),
  publishedAt: RawText.optional(),
  attachments: z.array(z.unknown()).optional(),
}).passthrough().superRefine(requireEntityId('file', ['id', 'attachmentId', 'contentId']));
export type RawFile = z.infer<typeof RawFileSchema>;

export const RawCollectionSchema = z.object({
  results: z.array(z.unknown()).optional(),
  items: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
  paging: RawPagingSchema.optional(),
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
