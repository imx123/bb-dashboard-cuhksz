import { createHash } from 'node:crypto';
import { ClassicApiError } from './api-errors.js';
import { rawId, rawRecord, rawString, RawAnnouncementSchema, RawCourseSchema, RawFileSchema } from './raw-schema.js';
import {
  AnnouncementV2Schema,
  AssignmentV2Schema,
  CourseFileV2Schema,
  CourseFileKindSchema,
  CourseV2Schema,
  emptyRichBody,
  emptySubmissionSummary,
  SnapshotErrorV2Schema,
  SnapshotV2Schema,
  type AnnouncementV2,
  type AssignmentKind,
  type AssignmentV2,
  type CourseFileV2,
  type CourseV2,
  type EvidenceV2,
  type Provenance,
  type SnapshotV2,
} from './schema-v2.js';
import { deriveSubmissionSummary } from './submissions.js';

export interface NormalizationContext {
  readonly fetchedAt: string;
  readonly source: Provenance['source'];
  readonly stale?: boolean;
}

function provenance(context: NormalizationContext): Provenance {
  return { source: context.source, fetchedAt: context.fetchedAt, stale: context.stale === true };
}

function requiredId(value: Record<string, unknown>, keys: string[], scope: string): string {
  const id = rawId(value, ...keys);
  if (!id) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 返回记录缺少稳定 ID。', { scope });
  return id;
}

function calendarDateValid(value: string): boolean {
  const match = /^(\d{4})[-\/](\d{2})[-\/](\d{2})/.exec(value);
  if (!match) return true;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function parseDate(value: unknown, scope: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 日期字段无法解释。', { scope });
  const text = value.trim();
  if (!calendarDateValid(text) || /^\d{4}[-\/]\d{2}[-\/]\d{2}$/.test(text) || !DATE_TIME_PATTERN.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 日期字段无法解释。', { scope });
  }
  return text;
}

function parseDateOnly(value: unknown, scope: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 日期字段无法解释。', { scope });
  const text = value.trim();
  const match = text.match(/^(\d{4})[-\/]([01]\d)[-\/]([0-3]\d)$/);
  if (!match) return null;
  if (!calendarDateValid(text)) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 返回了无效的日历日期。', { scope });
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function datePair(value: unknown, scope: string): { at: string | null; dateOnly: string | null } {
  const dateOnly = parseDateOnly(value, scope);
  return dateOnly ? { at: null, dateOnly } : { at: parseDate(value, scope), dateOnly: null };
}

function safeUrl(value: unknown, scope: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard URL 字段无法解释。', { scope });
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') throw new Error('scheme');
    return parsed.href;
  } catch {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard URL 字段无法解释。', { scope });
  }
}

function stableId(prefix: string, values: unknown[]): string {
  return `${prefix}:${createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24)}`;
}

function bodyText(value: unknown): string {
  if (typeof value === 'string') return value;
  const item = rawRecord(value);
  if (!item) return '';
  for (const key of ['displayText', 'rawText', 'text', 'content', 'description']) {
    if (typeof item[key] === 'string' && (item[key] as string).trim()) return item[key] as string;
  }
  return '';
}

function richBody(value: unknown) {
  // This placeholder has no sanitizer/parser yet, so it must never claim
  // that raw text or HTML is complete rich content.
  return emptyRichBody(bodyText(value), false);
}

function attachmentValues(value: unknown, prefix: string) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = rawRecord(entry);
    if (!item) return undefined;
    const name = rawString(item.name ?? item.title ?? item.fileName);
    if (!name) return undefined;
    const id = rawId(item, 'id', 'attachmentId') ?? stableId(prefix, [name, item.url ?? item.href, index]);
    return {
      id,
      name,
      mimeType: rawString(item.mimeType ?? item.contentType) ?? null,
      url: safeUrl(item.url ?? item.href ?? item.downloadUrl, `${prefix}:attachment`),
      resourceId: rawId(item, 'resourceId', 'contentId') ?? null,
    };
  }).filter((value): value is { id: string; name: string; mimeType: string | null; url: string | null; resourceId: string | null } => !!value);
}

function evidence(value: unknown, fallback: EvidenceV2): EvidenceV2 {
  return value === 'blackboard-field' || value === 'page-text' || value === 'user-entered' || value === 'unknown' ? value : fallback;
}

export function normalizeCourse(value: unknown, context: NormalizationContext): CourseV2 {
  const parsed = RawCourseSchema.parse(value);
  const item = parsed as Record<string, unknown>;
  const id = requiredId(item, ['id', 'courseId'], 'courses');
  const name = rawString(item.name ?? item.title ?? item.courseName);
  if (!name) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 课程记录缺少名称。', { scope: `course:${id}` });
  return CourseV2Schema.parse({
    id,
    name,
    code: rawString(item.code ?? item.courseCode) ?? null,
    url: safeUrl(item.url ?? item.courseUrl, `course:${id}:url`),
    ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
  });
}

export function normalizeAnnouncement(value: unknown, context: NormalizationContext): AnnouncementV2 {
  const parsed = RawAnnouncementSchema.parse(value);
  const item = parsed as Record<string, unknown>;
  const id = requiredId(item, ['id', 'announcementId'], 'announcements');
  const courseId = requiredId(item, ['courseId'], `announcement:${id}`);
  const title = rawString(item.title ?? item.subject ?? item.name);
  if (!title) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 公告记录缺少标题。', { scope: `announcement:${id}` });
  return AnnouncementV2Schema.parse({
    id,
    courseId,
    title,
    body: richBody(item.body ?? item.displayText ?? item.rawText),
    createdAt: parseDate(item.createdAt ?? item.createdDate, `announcement:${id}:createdAt`),
    modifiedAt: parseDate(item.modifiedAt ?? item.modifiedDate, `announcement:${id}:modifiedAt`),
    visibleFrom: parseDate(item.startDateRestriction, `announcement:${id}:visibleFrom`),
    visibleUntil: parseDate(item.endDateRestriction, `announcement:${id}:visibleUntil`),
    publishedAt: null,
    unread: null,
    localSeenAt: null,
    url: safeUrl(item.url ?? item.webLocation, `announcement:${id}:url`),
    provenance: provenance(context),
  });
}

function assignmentKind(value: unknown): AssignmentKind {
  const text = rawString(value)?.toLowerCase() ?? '';
  if (text.includes('test') || text.includes('exam')) return 'test';
  if (text.includes('assignment') || text.includes('homework')) return 'assignment';
  if (text.includes('graded')) return 'other-graded';
  return 'unknown';
}

export function normalizeAssignment(value: unknown, context: NormalizationContext): AssignmentV2 {
  const item = rawRecord(value);
  if (!item) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 作业记录不是对象。', { scope: 'assignment' });
  const id = requiredId(item, ['id', 'assignmentId', 'contentId', 'columnId'], 'assignments');
  const courseId = requiredId(item, ['courseId'], `assignment:${id}`);
  const title = rawString(item.title ?? item.name ?? item.assignment);
  if (!title) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 作业记录缺少标题。', { scope: `assignment:${id}` });
  const standard = datePair(item.standardDueAt ?? item.dueAt ?? item.dueDate ?? item.due ?? rawRecord(item.grading)?.due, `assignment:${id}:standardDue`);
  const personal = datePair(item.personalDueAt ?? item.personalDueDate, `assignment:${id}:personalDue`);
  const personalDueState = item.personalDueState === 'confirmed' ? 'confirmed' : 'unverified';
  const effective = personalDueState === 'confirmed' && (personal.at || personal.dateOnly) ? personal : standard;
  const dueConflict = Boolean((standard.at || standard.dateOnly) && (personal.at || personal.dateOnly) &&
    (standard.at ?? standard.dateOnly) !== (personal.at ?? personal.dateOnly));
  const submission = deriveSubmissionSummary(item.submission ?? item.grade ?? item);
  return AssignmentV2Schema.parse({
    id,
    courseId,
    contentId: rawId(item, 'contentId') ?? null,
    columnId: rawId(item, 'columnId') ?? null,
    kind: assignmentKind(item.kind ?? item.contentHandler ?? item.type),
    title,
    dueAt: effective.at,
    dueDateOnly: effective.dateOnly,
    dueEvidence: evidence(item.dueEvidence, standard.at || standard.dateOnly ? 'blackboard-field' : 'unknown'),
    standardDueAt: standard.at ?? (standard.dateOnly ? null : null),
    personalDueAt: personal.at ?? (personal.dateOnly ? null : null),
    personalDueState,
    dueConflict,
    url: safeUrl(item.url ?? item.webLocation, `assignment:${id}:url`),
    summary: typeof item.summary === 'string' ? item.summary : null,
    details: item.details === undefined && item.description === undefined ? null : richBody(item.details ?? item.description),
    attachments: attachmentValues(item.attachments, `assignment:${id}`),
    submission,
    provenance: provenance(context),
  });
}

export function normalizeFile(value: unknown, context: NormalizationContext): CourseFileV2 {
  const parsed = RawFileSchema.parse(value);
  const item = parsed as Record<string, unknown>;
  const id = requiredId(item, ['id', 'attachmentId', 'contentId'], 'files');
  const courseId = requiredId(item, ['courseId'], `file:${id}`);
  const contentId = requiredId(item, ['contentId', 'id'], `file:${id}`);
  const name = rawString(item.name ?? item.title ?? item.fileName);
  if (!name) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 文件记录缺少名称。', { scope: `file:${id}` });
  const kindText = rawString(item.kind ?? item.contentHandler ?? item.type)?.toLowerCase() ?? '';
  const kind = CourseFileKindSchema.options.find(value => kindText.includes(value)) ?? 'unknown';
  return CourseFileV2Schema.parse({
    id,
    courseId,
    contentId,
    name,
    kind,
    url: safeUrl(item.url ?? item.webLocation ?? item.permanentUrl, `file:${id}:url`),
    createdAt: parseDate(item.createdAt ?? item.createdDate, `file:${id}:createdAt`),
    modifiedAt: parseDate(item.modifiedAt ?? item.modifiedDate, `file:${id}:modifiedAt`),
    // The investigated Classic payload only establishes created/modified
    // semantics for content. Keep publication semantics unknown until a
    // dedicated field mapping is verified.
    publishedAt: null,
    mimeType: rawString(item.mimeType ?? item.contentType) ?? null,
    attachments: attachmentValues(item.attachments, `file:${id}`),
    provenance: provenance(context),
  });
}

export interface RawSnapshotInput {
  readonly state: SnapshotV2['state'];
  readonly fetchedAt: string;
  readonly source: SnapshotV2['source'];
  readonly courses: readonly unknown[];
  readonly announcements: readonly unknown[];
  readonly assignments: readonly unknown[];
  readonly files: readonly unknown[];
  readonly coverage: readonly unknown[];
  readonly errors: readonly unknown[];
}

export function normalizeSnapshot(input: RawSnapshotInput, context: NormalizationContext): SnapshotV2 {
  const value = {
    schemaVersion: 2 as const,
    state: input.state,
    fetchedAt: input.fetchedAt,
    timezone: 'Asia/Shanghai' as const,
    source: input.source,
    courses: input.courses.map(item => normalizeCourse(item, context)),
    announcements: input.announcements.map(item => normalizeAnnouncement(item, context)),
    assignments: input.assignments.map(item => normalizeAssignment(item, context)),
    files: input.files.map(item => normalizeFile(item, context)),
    coverage: input.coverage,
    errors: input.errors.map(item => SnapshotErrorV2Schema.parse(item)),
  };
  return SnapshotV2Schema.parse(value);
}
