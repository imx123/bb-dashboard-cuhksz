import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { debugLog } from '../debug-log.js';
import { ClassicError, classifyConnectorError, errorCode } from './errors.js';
import { classicUrl, courseUrl } from './url-policy.js';
import type { Announcement, Assignment, AuthResult, Course, CourseFile, Evidence, Snapshot, SnapshotError } from './schema.js';
import { AuthResultSchema, SnapshotErrorSchema, SnapshotSchema } from './schema.js';

export type ClassicResult = CallToolResult | undefined;

export interface CourseContext {
  id: string;
  name: string;
  code?: string | null;
  url?: string | null;
}

const textContent = (result: ClassicResult) => (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n').trim();

function structured(result: ClassicResult): unknown {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = textContent(result);
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : value === 'yes' ? true : value === 'no' ? false : undefined;
}

function hashId(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function rows(text: string): Array<Record<string, string>> {
  const output: Array<Record<string, string>> = [];
  let headers: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { headers = []; continue; }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(value => value.trim().replaceAll('\\|', '|'));
    if (cells.every(value => /^:?-+:?$/.test(value))) continue;
    if (!headers.length) { headers = cells; continue; }
    output.push(Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
  }
  return output;
}

function arrayPayload(value: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const object = record(value);
  for (const key of keys) if (Array.isArray(object?.[key])) return object[key] as unknown[];
  return undefined;
}

function validCourseId(value: unknown): value is string {
  return typeof value === 'string' && /^_\d+_\d+$/.test(value.trim());
}

function rawUrl(value: Record<string, unknown> | undefined): string | undefined {
  return classicUrl(value?.url ?? value?.href ?? value?.source ?? value?.link);
}

function rawDate(value: unknown): { dueAt: string | null; dueDateOnly?: string } {
  const text = stringValue(value);
  if (!text) return { dueAt: null };
  const dateOnly = text.match(/\b(\d{4})[-\/]([01]\d)[-\/]([0-3]\d)\b/);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text) || /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(text)) {
    if (!dateOnly) return { dueAt: null };
    return { dueAt: null, dueDateOnly: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}` };
  }
  // A time without an offset is ambiguous in scraped Classic pages. Keep it
  // unknown instead of silently treating the host's timezone as Shenzhen.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) return { dueAt: null };
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? { dueAt: text.replace(' ', 'T') } : { dueAt: null };
}

function evidence(value: unknown, fallback: Evidence): Evidence {
  return value === 'blackboard-field' || value === 'page-text' || value === 'user-entered' || value === 'unknown' ? value : fallback;
}

function courseFrom(value: unknown): Course | undefined {
  const item = record(value);
  if (!item) return undefined;
  const idValue = item.id ?? item.courseId ?? item.course_id ?? item.pk;
  const name = stringValue(item.name ?? item.title ?? item.course ?? item.courseName);
  if (!validCourseId(idValue) || !name) return undefined;
  const id = idValue.trim();
  const url = rawUrl(item) ?? (item.url === undefined ? courseUrl(id) : undefined);
  const code = stringValue(item.code ?? item.courseCode);
  const available = boolValue(item.available ?? item.isAvailable);
  return {
    id,
    name,
    code: code ?? null,
    url: url ?? null,
    ...(available === undefined ? {} : { available }),
  };
}

export function parseCourses(result: ClassicResult): Course[] {
  if (!result || result.isError) throw toolError(result, 'courses');
  const payload = structured(result);
  const items = arrayPayload(payload, ['courses', 'items', 'results']);
  if (items) {
    const parsed = items.map(courseFrom).filter((value): value is Course => !!value);
    if (parsed.length !== items.length) throw new ClassicError('COURSE_PARSE_CHANGED', '课程列表格式发生变化，未将不完整结果当成空列表。');
    const output = dedupCourses(parsed);
    debugLog.event('classic.parse.courses', { source: 'structured', courseCount: output.length });
    return output;
  }
  const parsed = rows(textContent(result)).map(row => courseFrom(row)).filter((value): value is Course => !!value);
  if (parsed.length) {
    const output = dedupCourses(parsed);
    debugLog.event('classic.parse.courses', { source: 'table', courseCount: output.length });
    return output;
  }
  const text = textContent(result);
  if (/^\s*(?:0\s+courses|no courses(?: found)?[.!]?)\s*$/i.test(text)) return [];
  throw new ClassicError('COURSE_PARSE_CHANGED', '课程列表格式发生变化，未将解析失败当成无课程。');
}

function dedupCourses(items: Course[]): Course[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function contextCourse(value: CourseContext): CourseContext {
  if (!validCourseId(value.id) || !value.name.trim()) throw new ClassicError('BAD_INPUT', '课程上下文无效。', { recoverable: false });
  return value;
}

function announcementFrom(value: unknown, course: CourseContext, index: number): Announcement | undefined {
  const item = record(value);
  if (!item) return undefined;
  const title = stringValue(item.title ?? item.name ?? item.subject);
  if (!title) return undefined;
  const published = rawDate(item.publishedAt ?? item.date ?? item.published ?? item.createdAt);
  const publishedAt = published.dueAt;
  const url = rawUrl(item);
  return {
    id: stringValue(item.id) ?? (url ? `announcement:${url}` : `announcement:${hashId([course.id, title, index])}`),
    courseId: course.id,
    title,
    body: String(item.body ?? item.text ?? item.content ?? '').slice(0, 100_000),
    publishedAt,
    url: url ?? null,
    unread: typeof item.unread === 'boolean' ? item.unread : null,
  };
}

export function parseAnnouncements(result: ClassicResult, input: CourseContext): Announcement[] {
  const course = contextCourse(input);
  if (!result || result.isError) throw toolError(result, `announcements:${course.id}`);
  const payload = structured(result);
  const items = arrayPayload(payload, ['announcements', 'items', 'results']);
  if (items) {
    const output = dedupAnnouncements(items.map((item, index) => announcementFrom(item, course, index)).filter((value): value is Announcement => !!value));
    debugLog.event('classic.parse.announcements', { source: 'structured', courseId: course.id, announcementCount: output.length });
    return output;
  }
  const text = textContent(result);
  if (/no announcements found|没有公告/i.test(text)) return [];
  const blocks = text.split(/\n\s*(?:──────|-{3,})\s*\n/).map(value => value.trim()).filter(Boolean);
  if (!blocks.length) throw new ClassicError('RESULT_PARSE_FAILED', '公告结果为空且没有可识别结构。');
  const parsed = blocks.map((block, index) => {
    const lines = block.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const header = lines.shift() ?? '';
    const date = header.match(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/i)?.[0];
    const title = header.replace(/^['"]|['"]$/g, '').replace(/\s*\|\s*.*$/, '').trim() || `公告 ${index + 1}`;
    const normalized = rawDate(date);
    return {
      id: `announcement:${hashId([course.id, title, index])}`,
      courseId: course.id,
      title,
      body: lines.join('\n').slice(0, 100_000),
      publishedAt: normalized.dueAt,
      url: classicUrl(header.match(/https:\/\/[^\s)]+/)?.[0]) ?? null,
      unread: null,
    } satisfies Announcement;
  });
  const output = dedupAnnouncements(parsed);
  debugLog.event('classic.parse.announcements', { source: 'text', courseId: course.id, announcementCount: output.length });
  return output;
}

function dedupAnnouncements(items: Announcement[]): Announcement[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function parseSnapshotResources<T>(items: unknown[], parser: (item: unknown, index: number) => T | undefined, label: string): T[] {
  const parsed = items.map(parser);
  if (parsed.some(item => item === undefined)) throw new ClassicError('RESULT_PARSE_FAILED', `Classic snapshot 的${label}记录格式无效，未将坏记录当成空数据。`);
  return parsed as T[];
}

function assignmentFrom(value: unknown, course: CourseContext, index: number): Assignment | undefined {
  const item = record(value);
  if (!item) return undefined;
  const title = stringValue(item.title ?? item.name ?? item.item ?? item.assignment);
  if (!title) return undefined;
  const url = rawUrl(item);
  const dateValue = item.dueAt ?? item.dueDateOnly ?? item.due ?? item.deadline ?? item.date;
  const date = rawDate(dateValue);
  const hasStructuredDue = item.dueAt !== undefined && item.dueAt !== null || item.dueDateOnly !== undefined && item.dueDateOnly !== null;
  const dueEvidence = evidence(item.dueEvidence, hasStructuredDue ? 'blackboard-field' : dateValue ? 'page-text' : 'unknown');
  return {
    id: stringValue(item.id) ?? (url ? `assignment:${url}` : `assignment:${hashId([course.id, title, index])}`),
    courseId: course.id,
    title,
    dueAt: date.dueAt,
    dueDateOnly: date.dueDateOnly ?? null,
    dueEvidence,
    url: url ?? null,
    remoteSubmission: item.remoteSubmission === 'submitted' || item.remoteSubmission === 'not-submitted' ? item.remoteSubmission : 'unknown',
    summary: typeof item.summary === 'string' ? item.summary.slice(0, 100_000) : null,
    attachments: Array.isArray(item.attachments) ? item.attachments.map((attachment) => {
      const value = record(attachment);
      const name = stringValue(value?.name ?? value?.title);
      const attachmentUrl = classicUrl(value?.url ?? value?.href);
      return name ? { name, url: attachmentUrl ?? null } : undefined;
    }).filter((value): value is { name: string; url: string | null } => !!value) : [],
  };
}

export function parseAssignments(result: ClassicResult, input: CourseContext): Assignment[] {
  const course = contextCourse(input);
  if (!result || result.isError) throw toolError(result, `assignments:${course.id}`);
  const payload = structured(result);
  const items = arrayPayload(payload, ['assignments', 'items', 'results']);
  if (items) {
    const output = dedupAssignments(items.map((item, index) => assignmentFrom(item, course, index)).filter((value): value is Assignment => !!value));
    debugLog.event('classic.parse.assignments', { source: 'structured', courseId: course.id, assignmentCount: output.length });
    return output;
  }
  const text = textContent(result);
  if (/no assignment(?: items| entries)? found|没有作业/i.test(text)) return [];
  const matches = [...text.matchAll(/^-\s*\[([^\]]+)\]\s*(.+)$/gim)];
  const detailMatches = [...text.matchAll(/^\[Assignment\]\s*(.+?)(?:\s*\(.*)?$/gim)];
  const parsed = (matches.length ? matches : detailMatches).map((match, index) => {
    const dateValue = matches.length ? match[1] : text.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 350).match(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/i)?.[0];
    return assignmentFrom({ title: matches.length ? match[2] : match[1], due: dateValue, dueEvidence: dateValue ? 'page-text' : 'unknown' }, course, index);
  }).filter((value): value is Assignment => !!value);
  if (!parsed.length) throw new ClassicError('RESULT_PARSE_FAILED', '作业结果没有可识别结构。');
  const output = dedupAssignments(parsed);
  debugLog.event('classic.parse.assignments', { source: 'text', courseId: course.id, assignmentCount: output.length });
  return output;
}

function dedupAssignments(items: Assignment[]): Assignment[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function fileFrom(value: unknown, course: CourseContext, index: number): CourseFile | undefined {
  const item = record(value);
  if (!item) return undefined;
  const name = stringValue(item.name ?? item.title ?? item.fileName ?? item.filename);
  if (!name) return undefined;
  const url = rawUrl(item);
  const date = rawDate(item.publishedAt ?? item.date ?? item.uploadedAt);
  return {
    id: stringValue(item.id) ?? (url ? `file:${url}` : `file:${hashId([course.id, name, index])}`),
    courseId: course.id,
    name,
    url: url ?? null,
    publishedAt: date.dueAt,
  };
}

export function parseFiles(result: ClassicResult, input: CourseContext): CourseFile[] {
  const course = contextCourse(input);
  if (!result || result.isError) throw toolError(result, `files:${course.id}`);
  const payload = structured(result);
  const items = arrayPayload(payload, ['files', 'items', 'results']);
  if (items) {
    const output = dedupFiles(items.map((item, index) => fileFrom(item, course, index)).filter((value): value is CourseFile => !!value));
    debugLog.event('classic.parse.files', { source: 'structured', courseId: course.id, fileCount: output.length });
    return output;
  }
  const text = textContent(result);
  if (/no files?(?: found| links found)?|没有文件|没有课件/i.test(text)) return [];
  const parsed = [...text.matchAll(/^-\s*\[([^\]]+)\]\s*(.+)$/gim)].map((match, index) => fileFrom({ name: match[2], date: match[1] }, course, index)).filter((value): value is CourseFile => !!value);
  if (!parsed.length) throw new ClassicError('RESULT_PARSE_FAILED', '资料结果没有可识别结构。');
  const output = dedupFiles(parsed);
  debugLog.event('classic.parse.files', { source: 'text', courseId: course.id, fileCount: output.length });
  return output;
}

/** Adapt the connector's one-call structured Snapshot.  This path is the
 * primary M3 protocol; the individual parsers above remain useful for
 * per-resource retries and legacy fixture diagnostics. */
export function parseSnapshotResult(result: ClassicResult): Snapshot {
  if (!result || result.isError) throw toolError(result, 'snapshot');
  const payload = record(structured(result));
  if (!payload || !Array.isArray(payload.courses) || !Array.isArray(payload.announcements) || !Array.isArray(payload.assignments) || !Array.isArray(payload.files)) {
    throw new ClassicError('RESULT_PARSE_FAILED', 'Classic snapshot 缺少结构化数组，未将结果当成空数据。');
  }
  const courseValues = parseCourses({ ...result, structuredContent: { courses: payload.courses } });
  const courses = new Map(courseValues.map(course => [course.id, course]));
  const courseFor = (value: unknown): CourseContext => {
    const item = record(value);
    const id = stringValue(item?.courseId ?? item?.course_id);
    const known = id ? courses.get(id) : undefined;
    if (!id || !known) throw new ClassicError('RESULT_PARSE_FAILED', 'Classic snapshot 含有无法关联课程的资源。');
    return known;
  };
  const announcements = dedupAnnouncements(parseSnapshotResources(payload.announcements, (item, index) => announcementFrom(item, courseFor(item), index), '公告'));
  const assignments = dedupAssignments(parseSnapshotResources(payload.assignments, (item, index) => assignmentFrom(item, courseFor(item), index), '作业'));
  const files = dedupFiles(parseSnapshotResources(payload.files, (item, index) => fileFrom(item, courseFor(item), index), '资料'));
  if (payload.state !== 'ok' && payload.state !== 'partial' && payload.state !== 'error' && payload.state !== 'auth-required') {
    throw new ClassicError('RESULT_PARSE_FAILED', 'Classic snapshot 的 state 无法识别，未将结果当成成功。');
  }
  if (payload.timezone !== 'Asia/Shanghai' || typeof payload.fetchedAt !== 'string' || !Number.isFinite(Date.parse(payload.fetchedAt)) || !Array.isArray(payload.errors)) {
    throw new ClassicError('RESULT_PARSE_FAILED', 'Classic snapshot 的时间或错误字段格式无效。');
  }
  let errors;
  try {
    errors = payload.errors.map(item => SnapshotErrorSchema.parse(item));
  } catch {
    throw new ClassicError('RESULT_PARSE_FAILED', 'Classic snapshot 的错误字段格式无效。');
  }
  const state = payload.state;
  const fetchedAt = payload.fetchedAt;
  const output = makeSnapshot({ state, fetchedAt, courses: courseValues, announcements, assignments, files, errors });
  debugLog.event('classic.parse.snapshot', {
    state,
    courseCount: output.courses.length,
    announcementCount: output.announcements.length,
    assignmentCount: output.assignments.length,
    fileCount: output.files.length,
    errorCount: output.errors.length,
  });
  return output;
}

export interface ClassicStatus {
  state: 'ok' | 'partial' | 'error' | 'auth-required';
  authenticated: boolean;
  next: string | null;
  errors: SnapshotError[];
  authResult?: AuthResult;
}

export function parseStatusResult(result: ClassicResult): ClassicStatus {
  if (!result || result.isError) throw toolError(result, 'status');
  const payload = record(structured(result));
  if (!payload || (payload.state !== 'ok' && payload.state !== 'partial' && payload.state !== 'error' && payload.state !== 'auth-required') || typeof payload.authenticated !== 'boolean') {
    throw new ClassicError('RESULT_PARSE_FAILED', 'Classic status 缺少明确的 state/authenticated 字段。');
  }
  let errors: SnapshotError[] = [];
  if (payload.errors !== undefined) {
    if (!Array.isArray(payload.errors)) throw new ClassicError('RESULT_PARSE_FAILED', 'Classic status 的错误字段格式无效。');
    try {
      errors = payload.errors.map(item => SnapshotErrorSchema.parse(item));
    } catch {
      throw new ClassicError('RESULT_PARSE_FAILED', 'Classic status 的错误字段格式无效。');
    }
  }
  let authResult: AuthResult | undefined;
  if (payload.authResult !== undefined) {
    try {
      authResult = AuthResultSchema.parse(payload.authResult);
    } catch {
      throw new ClassicError('RESULT_PARSE_FAILED', 'Classic status 的认证诊断格式无效。');
    }
  }
  return { state: payload.state, authenticated: payload.authenticated, next: typeof payload.next === 'string' ? payload.next : null, errors, ...(authResult ? { authResult } : {}) };
}

function dedupFiles(items: CourseFile[]): CourseFile[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

export function toolError(result: ClassicResult, scope: string): ClassicError {
  if (!result) return new ClassicError('RESULT_PARSE_FAILED', `${scope} 没有返回结果。`);
  const text = textContent(result);
  const payload = record(structured(result));
  const envelope = record(payload?.error)
    ?? (Array.isArray(payload?.errors) ? record(payload.errors[0]) : undefined)
    ?? payload;
  const envelopeCode = stringValue(envelope?.code);
  const envelopeMessage = stringValue(envelope?.message);
  if (envelopeCode || envelopeMessage) {
    const code = errorCode(envelopeCode);
    const message = code === 'UPSTREAM_FAILED' && !envelopeMessage
      ? `${scope} 读取失败。`
      : envelopeMessage ?? `${scope} 读取失败。`;
    return new ClassicError(code, message.slice(0, 240));
  }
  if (/not logged in|login failed|session|未登录|登录失败|登录后/i.test(text)) return new ClassicError('AUTH_REQUIRED', '需要在本机完成 Blackboard 登录。');
  if (/forbidden|permission|403|无权|权限/i.test(text)) return new ClassicError('FORBIDDEN', 'Blackboard 拒绝访问该内容。');
  const knownCode = text.match(/\b(AUTH_REQUIRED|AUTH_CHECK_UNRECOGNIZED|SESSION_EXPIRED|CONNECTOR_START_FAILED|CONNECTOR_DISCONNECTED|TIMEOUT|FORBIDDEN|NOT_FOUND|DOWNLOAD_FAILED|URL_REJECTED|TOOL_NOT_ALLOWED|TOOL_UNAVAILABLE|BAD_INPUT|UPSTREAM_FAILED)\b/)?.[1];
  if (knownCode) return new ClassicError(errorCode(knownCode), text.slice(0, 240));
  return new ClassicError('UPSTREAM_FAILED', `${scope} 读取失败。`);
}

export function errorEntry(scope: string, error: unknown): SnapshotError {
  const normalized = classifyConnectorError(error);
  return { scope, code: normalized.code, message: normalized.message };
}

export function makeSnapshot(input: Omit<Snapshot, 'fetchedAt' | 'timezone'> & { fetchedAt?: string; timezone?: 'Asia/Shanghai' }): Snapshot {
  const value = {
    ...input,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    timezone: input.timezone ?? 'Asia/Shanghai',
  };
  return SnapshotSchema.parse(value);
}
