import { debugLog } from '../debug-log.js';
import { ClassicApiError, isAuthenticationError, publicApiError, type PublicClassicApiError } from './api-errors.js';
import type { ClassicApiRequest, ClassicApiResource, ClassicApiTransport, ClassicRequestBudget, TraceId } from './api-contract.js';
import { collectionItems, parseRawCollection } from './raw-schema.js';
import type { ClassicEndpointTarget } from './endpoints.js';
import { ZodError } from 'zod';

export interface PaginatedResult<T> {
  readonly items: T[];
  readonly pages: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly nextPage: string | null;
  readonly errors: readonly PublicClassicApiError[];
}

export interface PaginationOptions<T> {
  readonly transport: ClassicApiTransport;
  readonly initial: ClassicEndpointTarget;
  readonly budget: ClassicRequestBudget;
  readonly traceId?: TraceId;
  readonly maxPages?: number;
  readonly mapItem?: (value: unknown, index: number) => T;
}

function pageRequest(target: ClassicEndpointTarget, budget: ClassicRequestBudget, traceId?: TraceId): ClassicApiRequest {
  return {
    method: 'GET',
    url: target.url,
    resource: target.resource,
    ...(target.courseId ? { courseId: target.courseId } : {}),
    ...(traceId ? { traceId } : {}),
    budget,
  };
}

const STATIC_QUERY_KEYS = ['userId', 'since', 'until', 'expand', 'fields'] as const;

const MAX_SCHEMA_ISSUES = 8;
const MAX_SCHEMA_DETAIL_LOGS = 8;
const MAX_SCHEMA_PATH_LENGTH = 120;
type PaginationStage = 'transport' | 'collection-envelope' | 'collection-item' | 'paging-link';

const SCHEMA_FIELD_KEYS = new Set([
  'id', 'courseId', 'contentId', 'announcementId', 'assignmentId', 'columnId', 'gradeId', 'attemptId', 'attachmentId',
  'calendarItemId', 'eventId', 'studentId', 'receiptId', 'submissionDate', 'submissionTotalSize', 'gradableItemId', 'userId',
  'nextPage', 'next', 'limit', 'offset', 'name', 'title', 'code', 'courseCode', 'url', 'availability',
  'subject', 'body', 'displayText', 'rawText', 'createdDate', 'createdAt', 'modifiedDate', 'modifiedAt',
  'startDateRestriction', 'endDateRestriction', 'startDate', 'endDate', 'publishedAt', 'unread',
  'description', 'contentHandler', 'hasChildren', 'attachments', 'due', 'dueDate', 'grading',
  'status', 'attemptStatus', 'submitted', 'submittedAt', 'attemptDate', 'attemptReceipt', 'lastAttempt', 'receipt', 'attempt',
  'calendarId', 'calendarItemId', 'eventId', 'type', 'start', 'end', 'modified', 'dynamicCalendarItemProps',
  'user', 'column', 'lastAttempt', 'attempt', 'attemptReceipt', 'receipt',
  'fileName', 'mimeType', 'created', 'results', 'items', 'data', 'paging',
]);

const ZOD_ISSUE_CODES = new Set([
  'invalid_type', 'invalid_literal', 'custom', 'invalid_union', 'invalid_union_discriminator', 'invalid_enum_value',
  'unrecognized_keys', 'invalid_arguments', 'invalid_return_type', 'invalid_date', 'invalid_string', 'too_small',
  'too_big', 'invalid_intersection_types', 'not_multiple_of', 'not_finite',
]);

const ZOD_TYPE_NAMES = new Set([
  'string', 'number', 'bigint', 'boolean', 'date', 'symbol', 'function', 'object', 'array', 'map', 'set',
  'promise', 'void', 'undefined', 'null', 'nan', 'unknown', 'never', 'integer', 'float',
]);

type SchemaValueShape = 'absent' | 'null' | 'empty-string' | 'string' | 'number' | 'array' | 'object' | 'boolean';

const SCHEMA_SHAPE_FIELDS = [
  'id', 'courseId', 'calendarItemId', 'eventId', 'contentId', 'columnId', 'gradeId', 'attemptId',
  'attachmentId', 'announcementId', 'assignmentId', 'userId', 'studentId', 'gradableItemId', 'calendarId',
  'dynamicCalendarItemProps', 'user', 'column', 'lastAttempt', 'attempt', 'attemptReceipt', 'receipt', 'type',
] as const;

const SCHEMA_SHAPE_NESTED_FIELDS = [
  ['user', 'id'], ['user', 'userId'],
  ['column', 'id'], ['column', 'columnId'], ['column', 'contentId'],
  ['lastAttempt', 'id'], ['lastAttempt', 'attemptId'], ['lastAttempt', 'status'], ['lastAttempt', 'attemptReceipt'],
  ['attempt', 'id'], ['attempt', 'attemptId'], ['attempt', 'status'], ['attempt', 'attemptReceipt'],
  ['attemptReceipt', 'receiptId'], ['attemptReceipt', 'submissionDate'],
  ['attemptReceipt', 'courseId'], ['attemptReceipt', 'userId'], ['attemptReceipt', 'gradableItemId'],
  ['dynamicCalendarItemProps', 'calendarItemId'], ['dynamicCalendarItemProps', 'eventId'],
  ['dynamicCalendarItemProps', 'columnId'], ['dynamicCalendarItemProps', 'gradableItemId'],
] as const;

interface SchemaDiagnostics {
  failureCount: number;
  detailLogCount: number;
  suppressedLogCount: number;
  lastCode: string;
  lastScope: string;
  lastStage: PaginationStage;
  summaryLogged: boolean;
}

function createSchemaDiagnostics(): SchemaDiagnostics {
  return {
    failureCount: 0,
    detailLogCount: 0,
    suppressedLogCount: 0,
    lastCode: 'API_SCHEMA_CHANGED',
    lastScope: '',
    lastStage: 'collection-envelope',
    summaryLogged: false,
  };
}

function zodCause(error: unknown, depth = 0): ZodError | undefined {
  if (error instanceof ZodError) return error;
  if (depth >= 2 || !(error instanceof ClassicApiError)) return undefined;
  return zodCause(error.cause, depth + 1);
}

function schemaValueShape(value: unknown): SchemaValueShape {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() ? 'string' : 'empty-string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  return 'object';
}

function shapeAtPath(value: unknown, path: readonly string[]): SchemaValueShape {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return schemaValueShape(undefined);
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, key)) return 'absent';
    current = record[key];
  }
  return schemaValueShape(current);
}

/**
 * Shape-only diagnostics for malformed API records.  The field names and
 * paths are static; values and unknown response keys never enter the log.
 */
function schemaFieldShapes(value: unknown): Record<string, SchemaValueShape> {
  const output: Record<string, SchemaValueShape> = {};
  for (const key of SCHEMA_SHAPE_FIELDS) output[key] = shapeAtPath(value, [key]);
  return output;
}

function schemaNestedFieldShapes(value: unknown): Record<string, SchemaValueShape> {
  const output: Record<string, SchemaValueShape> = {};
  for (const [parent, child] of SCHEMA_SHAPE_NESTED_FIELDS) output[`${parent}.${child}`] = shapeAtPath(value, [parent, child]);
  return output;
}

function safeSchemaPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '$';
  const parts = path.slice(0, 8).map(part => {
    if (typeof part === 'number') return '[*]';
    return SCHEMA_FIELD_KEYS.has(part) ? part : '[field]';
  });
  return parts.join('.').slice(0, MAX_SCHEMA_PATH_LENGTH) || '$';
}

function safeIssueCode(value: unknown): string {
  return typeof value === 'string' && ZOD_ISSUE_CODES.has(value) ? value : 'unknown';
}

function safeZodType(value: unknown): string {
  return typeof value === 'string' && ZOD_TYPE_NAMES.has(value) ? value : 'unknown';
}

function schemaIssueSummary(error: ZodError): {
  schemaIssueCount: number;
  schemaIssueCodes: string[];
  schemaIssuePaths: string[];
  schemaIssueTypes: Array<{ expected: string; received: string } | null>;
  schemaUnionLeafCount: number;
  schemaUnionLeafCodes: string[];
  schemaUnionLeafPaths: string[];
  schemaUnionLeafTypes: Array<{ expected: string; received: string } | null>;
} {
  const issues = error.issues.slice(0, MAX_SCHEMA_ISSUES);
  const unionLeaves: Array<{
    code: string;
    path: readonly (string | number)[];
    expected: string;
    received: string;
  }> = [];
  const collectUnionLeaves = (issue: unknown, depth: number, withinUnion: boolean): void => {
    if (!issue || typeof issue !== 'object') return;
    const typed = issue as { code?: unknown; path?: unknown; unionErrors?: unknown; expected?: unknown; received?: unknown };
    const path = Array.isArray(typed.path) ? typed.path.filter((part): part is string | number => typeof part === 'string' || typeof part === 'number') : [];
    const unionErrors = Array.isArray(typed.unionErrors) ? typed.unionErrors.filter(item => item instanceof ZodError) as ZodError[] : [];
    if (safeIssueCode(typed.code) === 'invalid_union' && unionErrors.length > 0 && depth < 2) {
      for (const unionError of unionErrors) for (const child of unionError.issues) collectUnionLeaves(child, depth + 1, true);
      return;
    }
    if (withinUnion) {
      unionLeaves.push({
        code: safeIssueCode(typed.code),
        path,
        expected: safeZodType(typed.expected),
        received: safeZodType(typed.received),
      });
    }
  };
  for (const issue of issues) if (safeIssueCode(issue.code) === 'invalid_union') collectUnionLeaves(issue, 0, false);
  const leafIssues = unionLeaves.slice(0, MAX_SCHEMA_ISSUES);
  const issueTypes = (items: readonly { code?: unknown }[]): Array<{ expected: string; received: string } | null> => items.map(issue => {
    if (safeIssueCode(issue.code) !== 'invalid_type') return null;
    const typedIssue = issue as { expected?: unknown; received?: unknown };
    return { expected: safeZodType(typedIssue.expected), received: safeZodType(typedIssue.received) };
  });
  return {
    schemaIssueCount: Math.min(error.issues.length, 99),
    schemaIssueCodes: issues.map(issue => safeIssueCode(issue.code)),
    schemaIssuePaths: issues.map(issue => safeSchemaPath(issue.path)),
    schemaIssueTypes: issueTypes(issues),
    schemaUnionLeafCount: unionLeaves.length,
    schemaUnionLeafCodes: leafIssues.map(issue => issue.code),
    schemaUnionLeafPaths: leafIssues.map(issue => safeSchemaPath(issue.path)),
    schemaUnionLeafTypes: leafIssues.map(issue => ({ expected: issue.expected, received: issue.received })),
  };
}

function logSchemaFailure(error: unknown, stage: PaginationStage, target: ClassicEndpointTarget, traceId: TraceId | undefined, diagnostics: SchemaDiagnostics, value?: unknown): void {
  const zod = zodCause(error);
  const typed = error instanceof ClassicApiError ? error : undefined;
  if (!zod && typed?.code !== 'API_SCHEMA_CHANGED') return;
  diagnostics.failureCount += 1;
  diagnostics.lastCode = typed?.code ?? 'API_SCHEMA_CHANGED';
  diagnostics.lastScope = typed?.scope ?? `pagination:${target.resource}`;
  diagnostics.lastStage = stage;
  if (diagnostics.detailLogCount >= MAX_SCHEMA_DETAIL_LOGS) {
    diagnostics.suppressedLogCount += 1;
    return;
  }
  const summary = zod
    ? schemaIssueSummary(zod)
    : {
      schemaIssueCount: 0,
      schemaIssueCodes: ['API_SCHEMA_CHANGED'],
      schemaIssuePaths: [],
      schemaIssueTypes: [],
      schemaUnionLeafCount: 0,
      schemaUnionLeafCodes: [],
      schemaUnionLeafPaths: [],
      schemaUnionLeafTypes: [],
    };
  debugLog.event('classic.api.schema-error', {
    traceId,
    resource: target.resource,
    courseId: target.courseId,
    stage,
    scope: diagnostics.lastScope,
    targetUrl: target.url.href,
    schemaFailureIndex: diagnostics.failureCount,
    ...(value === undefined ? {} : {
      schemaFieldShapes: schemaFieldShapes(value),
      schemaNestedFieldShapes: schemaNestedFieldShapes(value),
    }),
    ...summary,
  });
  diagnostics.detailLogCount += 1;
}

function logSchemaSummary(target: ClassicEndpointTarget, traceId: TraceId | undefined, diagnostics: SchemaDiagnostics, retainedItems: number): void {
  if (diagnostics.summaryLogged || diagnostics.failureCount === 0) return;
  diagnostics.summaryLogged = true;
  debugLog.event('classic.api.schema-summary', {
    traceId,
    resource: target.resource,
    courseId: target.courseId,
    stage: diagnostics.lastStage,
    scope: diagnostics.lastScope || `pagination:${target.resource}`,
    targetUrl: target.url.href,
    schemaLastCode: diagnostics.lastCode,
    schemaFailureCount: diagnostics.failureCount,
    schemaDetailLogCount: diagnostics.detailLogCount,
    schemaSuppressedLogCount: diagnostics.suppressedLogCount,
    retainedItems,
  });
}

function paginationError(error: unknown, scope: string, stage: PaginationStage = 'transport'): ClassicApiError {
  if (error instanceof ClassicApiError) return error;
  if (error instanceof ZodError || stage !== 'transport') {
    return new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 返回的数据结构无法识别。', { scope, retryable: false, cause: error });
  }
  return new ClassicApiError('NETWORK', 'Blackboard 分页读取失败。', { scope, cause: error });
}

type PaginationRejectReason = 'parse-invalid' | 'origin' | 'path' | 'course' | 'static-selector' | 'duplicate-selector';

const ISO_RANGE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

type RangeDiagnostic = {
  readonly rangesComparable: boolean;
  readonly intervalWithinOriginal: boolean;
};

function rangeInstant(value: string): number | undefined {
  const match = ISO_RANGE_DATETIME.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  if (zone === undefined) return undefined;
  const zoneHour = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rangeComparable(value: string): boolean {
  return rangeInstant(value) !== undefined;
}

function calendarRangeDiagnostics(target: ClassicEndpointTarget, next: URL | null): RangeDiagnostic | undefined {
  if (target.resource !== 'calendar' || !next) return undefined;
  const originalSince = target.url.searchParams.getAll('since');
  const originalUntil = target.url.searchParams.getAll('until');
  const nextSince = next.searchParams.getAll('since');
  const nextUntil = next.searchParams.getAll('until');
  if (originalSince.length !== 1 || originalUntil.length !== 1 || nextSince.length !== 1 || nextUntil.length !== 1) {
    return { rangesComparable: false, intervalWithinOriginal: false };
  }
  const originalSinceValue = originalSince[0];
  const originalUntilValue = originalUntil[0];
  const nextSinceValue = nextSince[0];
  const nextUntilValue = nextUntil[0];
  if (originalSinceValue === undefined || originalUntilValue === undefined || nextSinceValue === undefined || nextUntilValue === undefined) {
    return { rangesComparable: false, intervalWithinOriginal: false };
  }
  const originalSinceInstant = rangeInstant(originalSinceValue);
  const originalUntilInstant = rangeInstant(originalUntilValue);
  const nextSinceInstant = rangeInstant(nextSinceValue);
  const nextUntilInstant = rangeInstant(nextUntilValue);
  if (originalSinceInstant === undefined || originalUntilInstant === undefined || nextSinceInstant === undefined || nextUntilInstant === undefined) {
    return { rangesComparable: false, intervalWithinOriginal: false };
  }
  return {
    rangesComparable: true,
    intervalWithinOriginal: originalSinceInstant <= originalUntilInstant
      && nextSinceInstant >= originalSinceInstant
      && nextUntilInstant <= originalUntilInstant
      && nextSinceInstant <= nextUntilInstant,
  };
}

function selectorDiagnostics(selector: typeof STATIC_QUERY_KEYS[number], target: ClassicEndpointTarget, next: URL | null): Record<string, number | boolean> {
  const expected = target.url.searchParams.getAll(selector);
  const actual = next?.searchParams.getAll(selector) ?? [];
  const details: Record<string, number | boolean> = {
    expectedCount: expected.length,
    actualCount: actual.length,
    valuesEqual: expected.length === actual.length && expected.every((value, index) => value === actual[index]),
  };
  if (selector === 'since' || selector === 'until') {
    const expectedValue = expected[0];
    const actualValue = actual[0];
    const comparable = expected.length === 1 && actual.length === 1
      && expectedValue !== undefined && actualValue !== undefined
      && rangeComparable(expectedValue) && rangeComparable(actualValue);
    details.rangeComparable = comparable;
    if (comparable) details.rangeInstantEqual = Date.parse(expectedValue) === Date.parse(actualValue);
  }
  return details;
}

function logPaginationReject(reason: PaginationRejectReason, current: URL, target: ClassicEndpointTarget, next: URL | null, selector?: typeof STATIC_QUERY_KEYS[number], traceId?: TraceId): void {
  const range = selector === 'since' || selector === 'until' ? calendarRangeDiagnostics(target, next) : undefined;
  debugLog.event('classic.api.pagination-reject', {
    traceId,
    resource: target.resource,
    courseId: target.courseId,
    reason,
    ...(selector ? { selector } : {}),
    ...(selector ? selectorDiagnostics(selector, target, next) : {}),
    ...(range ?? {}),
    initialUrl: target.url.href,
    targetUrl: current.href,
    ...(next ? { nextUrl: next.href } : {}),
  });
}

function logAcceptedCalendarRange(current: URL, target: ClassicEndpointTarget, next: URL, selector: 'since' | 'until', traceId?: TraceId): void {
  const range = calendarRangeDiagnostics(target, next);
  if (!range) return;
  debugLog.event('classic.api.pagination-range', {
    traceId,
    resource: target.resource,
    courseId: target.courseId,
    accepted: true,
    selector,
    ...range,
    initialUrl: target.url.href,
    targetUrl: current.href,
    nextUrl: next.href,
  });
}

function rejectPaginationUrl(reason: PaginationRejectReason, message: string, current: URL, target: ClassicEndpointTarget, next: URL | null, selector?: typeof STATIC_QUERY_KEYS[number], traceId?: TraceId): never {
  logPaginationReject(reason, current, target, next, selector, traceId);
  throw new ClassicApiError('URL_REJECTED', message, { scope: `pagination:${target.resource}`, retryable: false });
}

function nextUrl(value: string, current: URL, target: ClassicEndpointTarget, traceId?: TraceId): URL | null {
  if (!value.trim()) return null;
  let next: URL;
  try { next = new URL(value, current); } catch {
    logPaginationReject('parse-invalid', current, target, null, undefined, traceId);
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 分页链接无法解析。', { scope: `pagination:${target.resource}`, retryable: false });
  }
  if (next.origin !== 'https://bb.cuhk.edu.cn' || next.protocol !== 'https:' || next.username || next.password || next.port || next.hash) {
    return rejectPaginationUrl('origin', 'Blackboard 分页链接超出固定学校 origin。', current, target, next, undefined, traceId);
  }
  if (next.pathname !== target.familyPrefix) {
    return rejectPaginationUrl('path', 'Blackboard 分页链接超出当前接口族。', current, target, next, undefined, traceId);
  }
  if (target.courseId) {
    let path = next.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep encoded path for the containment check. */ }
    if (!path.split('/').includes(target.courseId)) return rejectPaginationUrl('course', 'Blackboard 分页链接超出当前课程。', current, target, next, undefined, traceId);
  }
  // Relative links emitted by Blackboard sometimes omit static query values.
  // Restore omitted values. Account and non-calendar range selectors remain
  // strict; calendar ranges may only narrow the original authorized window.
  let changedRangeSelector: 'since' | 'until' | undefined;
  for (const key of STATIC_QUERY_KEYS) {
    const expected = target.url.searchParams.getAll(key);
    const actual = next.searchParams.getAll(key);
    if (key === 'userId' && (expected.length > 1 || actual.length > 1)) {
      return rejectPaginationUrl('duplicate-selector', 'Blackboard 分页链接重复指定了用户范围。', current, target, next, key, traceId);
    }
    if (expected.length === 0) {
      if (actual.length > 0) return rejectPaginationUrl('static-selector', 'Blackboard 分页链接新增了未授权的读取范围。', current, target, next, key, traceId);
      continue;
    }
    if (actual.length === 0) {
      for (const valuePart of expected) next.searchParams.append(key, valuePart);
      continue;
    }
    if (key === 'since' || key === 'until') {
      if (actual.length !== expected.length || actual.some((part, index) => part !== expected[index])) {
        changedRangeSelector ??= key;
      }
      continue;
    }
    if (actual.length !== expected.length || actual.some((part, index) => part !== expected[index])) {
      return rejectPaginationUrl('static-selector', 'Blackboard 分页链接改变了当前读取范围。', current, target, next, key, traceId);
    }
  }
  if (changedRangeSelector) {
    const range = calendarRangeDiagnostics(target, next);
    if (range?.rangesComparable && range.intervalWithinOriginal) {
      logAcceptedCalendarRange(current, target, next, changedRangeSelector, traceId);
      return next;
    }
    return rejectPaginationUrl('static-selector', 'Blackboard 分页链接改变了当前读取范围。', current, target, next, changedRangeSelector, traceId);
  }
  return next;
}

function pagingLink(value: ReturnType<typeof parseRawCollection>): string | null {
  const paging = value.paging;
  if (!paging) return null;
  const link = paging.nextPage ?? paging.next ?? null;
  return typeof link === 'string' ? link : null;
}

/**
 * Bounded collection reader. It keeps empty successful collections distinct
 * from malformed envelopes and never follows a cross-origin or cross-family
 * next link.
 */
export async function paginateCollection<T = unknown>(options: PaginationOptions<T>): Promise<PaginatedResult<T>> {
  const maxPages = options.maxPages ?? 20;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) throw new ClassicApiError('BAD_INPUT', '分页页数上限无效。', { scope: 'pagination', retryable: false });
  const seen = new Set<string>();
  const items: T[] = [];
  let target = options.initial;
  let pages = 0;
  let next: string | null = null;
  const errors: PublicClassicApiError[] = [];
  let itemErrors = false;
  const schemaDiagnostics = createSchemaDiagnostics();
  const finishPartial = (error: unknown, stage: PaginationStage = 'transport'): PaginatedResult<T> => {
    const typed = paginationError(error, `pagination:${options.initial.resource}`, stage);
    logSchemaFailure(typed, stage, target, options.traceId, schemaDiagnostics);
    logSchemaSummary(target, options.traceId, schemaDiagnostics, items.length);
    if (isAuthenticationError(typed)) throw typed;
    errors.push(publicApiError(typed));
    return { items, pages, complete: false, truncated: typed.code === 'PARTIAL_RESULTS' || next !== null, nextPage: next, errors };
  };
  while (pages < maxPages) {
    if (seen.has(target.url.href)) return finishPartial(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 分页链接出现循环。', { scope: `pagination:${target.resource}`, retryable: false }), 'paging-link');
    seen.add(target.url.href);
    let stage: PaginationStage = 'transport';
    try {
      const response = await options.transport.request<unknown>(pageRequest(target, options.budget, options.traceId));
      pages += 1;
      stage = 'collection-envelope';
      const page = parseRawCollection(response.data, `pagination:${target.resource}`);
      const values = collectionItems(page);
      if (values.length === 0 && pagingLink(page)) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 空分页页仍带有 next link。', { scope: `pagination:${target.resource}`, retryable: false });
      stage = 'collection-item';
      const pageItems: T[] = [];
      for (let index = 0; index < values.length; index += 1) {
        try {
          pageItems.push(options.mapItem ? options.mapItem(values[index], items.length + index) : values[index] as T);
        } catch (error) {
          const typed = paginationError(error, `pagination:${target.resource}:item`, 'collection-item');
          logSchemaFailure(typed, 'collection-item', target, options.traceId, schemaDiagnostics, values[index]);
          if (isAuthenticationError(typed)) throw typed;
          itemErrors = true;
          if (errors.length < MAX_SCHEMA_ISSUES) errors.push(publicApiError(typed));
        }
      }
      items.push(...pageItems);
      next = pagingLink(page);
      if (!next) {
        logSchemaSummary(target, options.traceId, schemaDiagnostics, items.length);
        return { items, pages, complete: !itemErrors, truncated: false, nextPage: null, errors };
      }
      if (pages >= maxPages) break;
      stage = 'paging-link';
      const url = nextUrl(next, target.url, options.initial, options.traceId);
      if (!url) {
        logSchemaSummary(target, options.traceId, schemaDiagnostics, items.length);
        return { items, pages, complete: !itemErrors, truncated: false, nextPage: null, errors };
      }
      target = { ...target, url };
    } catch (error) {
      return finishPartial(error, stage);
    }
  }
  const limitError = new ClassicApiError('PARTIAL_RESULTS', 'Blackboard 分页达到本次读取上限。', { scope: `pagination:${options.initial.resource}` });
  logSchemaSummary(target, options.traceId, schemaDiagnostics, items.length);
  errors.push(publicApiError(limitError));
  return { items, pages, complete: false, truncated: true, nextPage: next, errors };
}

export function createRequestBudget(signal: AbortSignal, options: { deadlineMs?: number; requestLimit?: number; responseBytesLimit?: number; reserveRequests?: number; reserveMs?: number } = {}): ClassicRequestBudget {
  const deadlineMs = options.deadlineMs ?? 90_000;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 180_000) throw new ClassicApiError('BAD_INPUT', 'Classic 同步 deadline 无效。', { scope: 'pagination.budget', retryable: false });
  const requestLimit = options.requestLimit ?? 300;
  if (!Number.isInteger(requestLimit) || requestLimit < 1 || requestLimit > 1_000) throw new ClassicApiError('BAD_INPUT', 'Classic 请求数预算无效。', { scope: 'pagination.budget', retryable: false });
  const reserveRequests = options.reserveRequests ?? 0;
  if (!Number.isInteger(reserveRequests) || reserveRequests < 0 || reserveRequests >= requestLimit) throw new ClassicApiError('BAD_INPUT', 'Classic 预算保留请求数无效。', { scope: 'pagination.budget', retryable: false });
  const reserveMs = options.reserveMs ?? 0;
  if (!Number.isInteger(reserveMs) || reserveMs < 0 || reserveMs >= deadlineMs) throw new ClassicApiError('BAD_INPUT', 'Classic 预算保留时间无效。', { scope: 'pagination.budget', retryable: false });
  const responseBytesLimit = options.responseBytesLimit ?? 2_000_000;
  if (!Number.isInteger(responseBytesLimit) || responseBytesLimit < 1_024 || responseBytesLimit > 20_000_000) throw new ClassicApiError('BAD_INPUT', 'Classic 响应体预算无效。', { scope: 'pagination.budget', retryable: false });
  return { signal, deadlineAt: Date.now() + deadlineMs, requestLimit, responseBytesLimit, reserveRequests, reserveMs };
}

export function assertPageResource(resource: ClassicApiResource, expected: ClassicApiResource): void {
  if (resource !== expected) throw new ClassicApiError('BAD_INPUT', '分页资源类型不匹配。', { scope: 'pagination', retryable: false });
}
