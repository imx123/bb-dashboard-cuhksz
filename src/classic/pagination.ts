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
  'receiptId', 'submissionDate', 'submissionTotalSize', 'gradableItemId', 'userId',
  'nextPage', 'next', 'limit', 'offset', 'name', 'title', 'code', 'courseCode', 'url', 'availability',
  'subject', 'body', 'displayText', 'rawText', 'createdDate', 'createdAt', 'modifiedDate', 'modifiedAt',
  'startDateRestriction', 'endDateRestriction', 'startDate', 'endDate', 'publishedAt', 'unread',
  'description', 'contentHandler', 'hasChildren', 'attachments', 'due', 'dueDate', 'grading',
  'status', 'attemptStatus', 'submitted', 'submittedAt', 'attemptDate', 'attemptReceipt', 'lastAttempt', 'receipt', 'attempt',
  'calendarId', 'type', 'start', 'end', 'modified', 'dynamicCalendarItemProps',
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

function schemaIssueSummary(error: ZodError): { schemaIssueCount: number; schemaIssueCodes: string[]; schemaIssuePaths: string[]; schemaIssueTypes: Array<{ expected: string; received: string } | null> } {
  const issues = error.issues.slice(0, MAX_SCHEMA_ISSUES);
  return {
    schemaIssueCount: Math.min(error.issues.length, 99),
    schemaIssueCodes: issues.map(issue => safeIssueCode(issue.code)),
    schemaIssuePaths: issues.map(issue => safeSchemaPath(issue.path)),
    schemaIssueTypes: issues.map(issue => {
      if (safeIssueCode(issue.code) !== 'invalid_type') return null;
      const typedIssue = issue as { expected?: unknown; received?: unknown };
      return { expected: safeZodType(typedIssue.expected), received: safeZodType(typedIssue.received) };
    }),
  };
}

function logSchemaFailure(error: unknown, stage: PaginationStage, target: ClassicEndpointTarget, traceId: TraceId | undefined, diagnostics: SchemaDiagnostics): void {
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
    : { schemaIssueCount: 0, schemaIssueCodes: ['API_SCHEMA_CHANGED'], schemaIssuePaths: [], schemaIssueTypes: [] };
  debugLog.event('classic.api.schema-error', {
    traceId,
    resource: target.resource,
    courseId: target.courseId,
    stage,
    scope: diagnostics.lastScope,
    targetUrl: target.url.href,
    schemaFailureIndex: diagnostics.failureCount,
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

function nextUrl(value: string, current: URL, target: ClassicEndpointTarget): URL | null {
  if (!value.trim()) return null;
  let next: URL;
  try { next = new URL(value, current); } catch { throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 分页链接无法解析。', { scope: `pagination:${target.resource}`, retryable: false }); }
  if (next.origin !== 'https://bb.cuhk.edu.cn' || next.protocol !== 'https:' || next.username || next.password || next.port || next.hash) {
    throw new ClassicApiError('URL_REJECTED', 'Blackboard 分页链接超出固定学校 origin。', { scope: `pagination:${target.resource}`, retryable: false });
  }
  if (next.pathname !== target.familyPrefix) {
    throw new ClassicApiError('URL_REJECTED', 'Blackboard 分页链接超出当前接口族。', { scope: `pagination:${target.resource}`, retryable: false });
  }
  if (target.courseId) {
    let path = next.pathname;
    try { path = decodeURIComponent(path); } catch { /* Keep encoded path for the containment check. */ }
    if (!path.split('/').includes(target.courseId)) throw new ClassicApiError('URL_REJECTED', 'Blackboard 分页链接超出当前课程。', { scope: `pagination:${target.resource}`, retryable: false });
  }
  // Relative links emitted by Blackboard sometimes omit static query values.
  // Restore omitted values, but reject both duplicate and newly-added account
  // or range selectors so a next link cannot silently change the read scope.
  for (const key of STATIC_QUERY_KEYS) {
    const expected = target.url.searchParams.getAll(key);
    const actual = next.searchParams.getAll(key);
    if (key === 'userId' && (expected.length > 1 || actual.length > 1)) {
      throw new ClassicApiError('URL_REJECTED', 'Blackboard 分页链接重复指定了用户范围。', { scope: `pagination:${target.resource}`, retryable: false });
    }
    if (expected.length === 0) {
      if (actual.length > 0) throw new ClassicApiError('URL_REJECTED', 'Blackboard 分页链接新增了未授权的读取范围。', { scope: `pagination:${target.resource}`, retryable: false });
      continue;
    }
    if (actual.length === 0) {
      for (const valuePart of expected) next.searchParams.append(key, valuePart);
      continue;
    }
    if (actual.length !== expected.length || actual.some((part, index) => part !== expected[index])) {
      throw new ClassicApiError('URL_REJECTED', 'Blackboard 分页链接改变了当前读取范围。', { scope: `pagination:${target.resource}`, retryable: false });
    }
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
          logSchemaFailure(typed, 'collection-item', target, options.traceId, schemaDiagnostics);
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
      const url = nextUrl(next, target.url, options.initial);
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
