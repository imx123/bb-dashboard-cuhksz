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
  type SubmissionSummary,
  type SnapshotV2,
} from './schema-v2.js';
import { deriveSubmissionSummary, TRUSTED_FEEDBACK } from './submissions.js';
import { sanitizeRichBody, type RichTextOptions } from './rich-text.js';
import type { ClassicResourceRegistrar } from './detail-reader.js';
import { CLASSIC_API_ORIGIN } from './api-contract.js';

export interface NormalizationContext {
  readonly fetchedAt: string;
  readonly source: Provenance['source'];
  readonly stale?: boolean;
  readonly traceId?: string;
  readonly richText?: RichTextOptions;
  readonly resourceRegistry?: ClassicResourceRegistrar;
  /** Live API orchestration opts into verified Classic page fallbacks. */
  readonly allowClassicFallback?: boolean;
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

const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

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

/** Compare the same due value across API representations without letting
 * equivalent offsets (or a Shanghai-local date-only value) create a false
 * conflict. */
export function sameDueValue(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  const leftDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(left);
  const rightDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(right);
  if (leftDateOnly && rightDateOnly) return left === right;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return left === right;
  if (!leftDateOnly && !rightDateOnly) return leftMs === rightMs;
  const timed = leftDateOnly ? rightMs : leftMs;
  const dateOnly = leftDateOnly ? left : right;
  // Asia/Shanghai is UTC+08:00 for this product's displayed date.  Keep the
  // comparison independent of the machine's local timezone.
  return new Date(timed + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === dateOnly;
}

function safeUrl(value: unknown, scope: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim()) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard URL 字段无法解释。', { scope });
  try {
    // Classic payloads use both absolute and same-origin relative links. The
    // resolved URL is only a DTO link; resource registration below still
    // enforces the school origin before attaching session cookies.
    const parsed = new URL(value.trim(), CLASSIC_API_ORIGIN);
    if (parsed.protocol !== 'https:') throw new Error('scheme');
    if (parsed.username || parsed.password || parsed.port || parsed.hash) throw new Error('url credentials');
    return parsed.href;
  } catch {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard URL 字段无法解释。', { scope });
  }
}

function safeSchoolSourceUrl(value: unknown, scope: string): string | null {
  const candidate = safeUrl(value, scope);
  if (!candidate) return null;
  const parsed = new URL(candidate);
  if (parsed.origin !== CLASSIC_API_ORIGIN) return null;
  if (hasSensitiveQuery(parsed)) return null;
  return parsed.href;
}

function hasSensitiveQuery(url: URL): boolean {
  for (const [key] of url.searchParams) if (SENSITIVE_URL_QUERY.test(key)) return true;
  return false;
}

function classicPage(path: string, params: Record<string, string>): string {
  const url = new URL(path, CLASSIC_API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

function courseSourceUrl(courseId: string): string {
  // The launcher is the only course entry shape already present in the
  // historical Classic connector.  The module page may require a portal tab
  // parameter that the JSON payload does not provide, so it is not guessed.
  return classicPage('/webapps/blackboard/execute/launcher', { type: 'Course', id: courseId, url: '' });
}

function announcementSourceUrl(courseId: string): string {
  return classicPage('/webapps/blackboard/execute/announcement', { course_id: courseId });
}

function contentSourceUrl(courseId: string, contentId: string): string {
  return classicPage('/webapps/blackboard/content/listContent.jsp', { course_id: courseId, content_id: contentId });
}

const SENSITIVE_URL_QUERY = /(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key|otp|mfa)/i;

function stableAttachmentUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== CLASSIC_API_ORIGIN || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (hasSensitiveQuery(url)) return null;
    return url.href;
  } catch { return null; }
}

function attachmentDownloadUrl(courseId: string | undefined, contentId: string | undefined, attachmentId: string, fallback: string | null): string | null {
  if (!courseId || !contentId) return stableAttachmentUrl(fallback);
  const url = new URL(
    `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
    CLASSIC_API_ORIGIN,
  );
  return url.href;
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

function richBody(value: unknown, context: NormalizationContext, baseUrl?: string, courseId?: string, contentId?: string) {
  try {
    return sanitizeRichBody(value, {
      ...context.richText,
      baseUrl: context.richText?.baseUrl ?? baseUrl,
      registerImage: (url, alt) => {
        const resourceId = context.resourceRegistry?.register({ kind: 'image', url, courseId, contentId, traceId: context.traceId });
        return resourceId ? { resourceId, alt } : null;
      },
    });
  } catch {
    return emptyRichBody(bodyText(value), false);
  }
}

/** Normalize the student-visible attempt fields before deriving submission state. */
export function normalizeSubmission(value: unknown, context: NormalizationContext, baseUrl?: string, courseId?: string, contentId?: string): SubmissionSummary {
  const source = rawRecord(value) ?? {};
  const sanitizeHolder = (candidate: unknown): Record<string, unknown> | undefined => {
    const item = rawRecord(candidate);
    if (!item) return undefined;
    const feedbackValue = item.feedback ?? item.feedbackToUser;
    if (feedbackValue === undefined) return item;
    const sanitized = richBody(feedbackValue, context, baseUrl, courseId, contentId);
    return { ...item, feedback: sanitized, feedbackToUser: sanitized, [TRUSTED_FEEDBACK]: true };
  };
  const attempt = sanitizeHolder(source.lastAttempt ?? source.attempt);
  const rawHistory = Array.isArray(source.history) ? source.history : undefined;
  const history = rawHistory?.map(item => sanitizeHolder(item) ?? item);
  const historyFeedback = history?.slice().reverse().map(item => rawRecord(item)?.feedback ?? rawRecord(item)?.feedbackToUser).find(item => item !== undefined);
  const feedbackValue = source.feedback ?? source.feedbackToUser ?? attempt?.feedbackToUser ?? attempt?.feedback ?? historyFeedback;
  const prepared = {
    ...source,
    ...(source.lastAttempt !== undefined ? { lastAttempt: attempt } : {}),
    ...(source.attempt !== undefined ? { attempt } : {}),
    ...(history ? { history } : {}),
    ...(feedbackValue === undefined ? {} : { feedback: richBody(feedbackValue, context, baseUrl, courseId, contentId), [TRUSTED_FEEDBACK]: true }),
  };
  return deriveSubmissionSummary(prepared);
}

function attachmentValues(value: unknown, prefix: string, context: NormalizationContext, courseId?: string, contentId?: string) {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = rawRecord(entry);
    if (!item) return undefined;
    const name = rawString(item.name ?? item.title ?? item.fileName);
    if (!name) return undefined;
    const id = rawId(item, 'id', 'attachmentId') ?? stableId(prefix, [name, item.url ?? item.href, index]);
    const safeAttachmentUrl = safeUrl(item.url ?? item.href ?? item.downloadUrl, `${prefix}:attachment`);
    // Keep a stable public download entry in the DTO. A signed/permanent
    // response URL may still be used by the main-process registry for this
    // read, but it never becomes durable renderer data.
    const persistentAttachmentUrl = attachmentDownloadUrl(courseId, contentId, id, safeAttachmentUrl);
    let resourceId: string | null = null;
    if (safeAttachmentUrl && context.resourceRegistry) {
      try { resourceId = context.resourceRegistry.register({ kind: 'attachment', url: safeAttachmentUrl, courseId, contentId, mimeType: rawString(item.mimeType ?? item.contentType) ?? null, traceId: context.traceId }); }
      catch { resourceId = null; }
    }
    return {
      id,
      name,
      mimeType: rawString(item.mimeType ?? item.contentType) ?? null,
      url: persistentAttachmentUrl,
      resourceId,
    };
  }).filter((value): value is { id: string; name: string; mimeType: string | null; url: string | null; resourceId: string | null } => !!value);
}

function evidence(value: unknown, fallback: EvidenceV2): EvidenceV2 {
  return value === 'blackboard-field' || value === 'calendar' || value === 'page-text' || value === 'user-entered' || value === 'unknown' ? value : fallback;
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
    url: safeSchoolSourceUrl(item.url ?? item.courseUrl, `course:${id}:url`) ?? (context.allowClassicFallback ? courseSourceUrl(id) : null),
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
  const sourceUrl = safeSchoolSourceUrl(item.url ?? item.webLocation, `announcement:${id}:url`) ?? (context.allowClassicFallback ? announcementSourceUrl(courseId) : null);
  return AnnouncementV2Schema.parse({
    id,
    courseId,
    title,
    body: richBody(item.body ?? item.displayText ?? item.rawText, context, sourceUrl ?? undefined, courseId),
    createdAt: parseDate(item.createdAt ?? item.createdDate, `announcement:${id}:createdAt`),
    modifiedAt: parseDate(item.modifiedAt ?? item.modifiedDate, `announcement:${id}:modifiedAt`),
    visibleFrom: parseDate(item.startDateRestriction, `announcement:${id}:visibleFrom`),
    visibleUntil: parseDate(item.endDateRestriction, `announcement:${id}:visibleUntil`),
    publishedAt: null,
    unread: null,
    localSeenAt: null,
    url: sourceUrl,
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
    !sameDueValue(standard.at ?? standard.dateOnly, personal.at ?? personal.dateOnly));
  const contentId = rawId(item, 'contentId');
  const columnId = rawId(item, 'columnId') ?? null;
  const assignmentUrl = safeSchoolSourceUrl(item.url ?? item.webLocation, `assignment:${id}:url`) ?? (context.allowClassicFallback && contentId ? contentSourceUrl(courseId, contentId) : null);
  const submissionValue = rawRecord(item.submission ?? item.grade) ?? item;
  const submission = normalizeSubmission(submissionValue, context, assignmentUrl ?? undefined, courseId, contentId);
  return AssignmentV2Schema.parse({
    id,
    courseId,
    contentId: contentId ?? null,
    columnId,
    ...(columnId ? { columnIds: [columnId] } : {}),
    kind: assignmentKind(item.kind ?? item.contentHandler ?? item.type),
    title,
    dueAt: effective.at,
    dueDateOnly: effective.dateOnly,
    dueEvidence: evidence(item.dueEvidence, standard.at || standard.dateOnly ? 'blackboard-field' : 'unknown'),
    standardDueAt: standard.at ?? (standard.dateOnly ? null : null),
    personalDueAt: personal.at ?? (personal.dateOnly ? null : null),
    personalDueState,
    dueConflict,
    url: assignmentUrl,
    summary: typeof item.summary === 'string' ? item.summary : null,
    details: item.body === undefined && item.details === undefined && item.description === undefined ? null : richBody(item.body ?? item.details ?? item.description, context, assignmentUrl ?? undefined, courseId, contentId),
    attachments: attachmentValues(item.attachments, `assignment:${id}`, context, courseId, contentId),
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
  const rawSourceUrl = safeUrl(item.url ?? item.webLocation ?? item.permanentUrl, `file:${id}:url`);
  const schoolSourceUrl = safeSchoolSourceUrl(item.url ?? item.webLocation ?? item.permanentUrl, `file:${id}:url`);
  const externalCandidate = rawSourceUrl ? new URL(rawSourceUrl) : null;
  const externalUrl = externalCandidate && externalCandidate.origin !== CLASSIC_API_ORIGIN && !hasSensitiveQuery(externalCandidate) ? rawSourceUrl : null;
  return CourseFileV2Schema.parse({
    id,
    courseId,
    contentId,
    name,
    kind,
    // Every file row keeps a same-origin Blackboard content page for the
    // authenticated source action. External targets are a separate optional
    // field so they can be opened by an explicit system-browser action.
    url: schoolSourceUrl ?? (context.allowClassicFallback ? contentSourceUrl(courseId, contentId) : null),
    externalUrl,
    createdAt: parseDate(item.createdAt ?? item.createdDate ?? item.created, `file:${id}:createdAt`),
    modifiedAt: parseDate(item.modifiedAt ?? item.modifiedDate ?? item.modified, `file:${id}:modifiedAt`),
    // The investigated Classic payload only establishes created/modified
    // semantics for content. Keep publication semantics unknown until a
    // dedicated field mapping is verified.
    publishedAt: null,
    mimeType: rawString(item.mimeType ?? item.contentType) ?? null,
    attachments: attachmentValues(item.attachments, `file:${id}`, context, courseId, contentId),
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
