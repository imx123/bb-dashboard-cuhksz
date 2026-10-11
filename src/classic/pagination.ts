import { ClassicApiError, isAuthenticationError, publicApiError, type PublicClassicApiError } from './api-errors.js';
import type { ClassicApiRequest, ClassicApiResource, ClassicApiTransport, ClassicRequestBudget, TraceId } from './api-contract.js';
import { collectionItems, parseRawCollection } from './raw-schema.js';
import type { ClassicEndpointTarget } from './endpoints.js';

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

function paginationError(error: unknown, scope: string): ClassicApiError {
  if (error instanceof ClassicApiError) return error;
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
  const finishPartial = (error: unknown): PaginatedResult<T> => {
    const typed = paginationError(error, `pagination:${options.initial.resource}`);
    if (isAuthenticationError(typed)) throw typed;
    errors.push(publicApiError(typed));
    return { items, pages, complete: false, truncated: typed.code === 'PARTIAL_RESULTS' || next !== null, nextPage: next, errors };
  };
  while (pages < maxPages) {
    if (seen.has(target.url.href)) return finishPartial(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 分页链接出现循环。', { scope: `pagination:${target.resource}`, retryable: false }));
    seen.add(target.url.href);
    try {
      const response = await options.transport.request<unknown>(pageRequest(target, options.budget, options.traceId));
      pages += 1;
      const page = parseRawCollection(response.data, `pagination:${target.resource}`);
      const values = collectionItems(page);
      if (values.length === 0 && pagingLink(page)) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 空分页页仍带有 next link。', { scope: `pagination:${target.resource}`, retryable: false });
      const pageItems: T[] = [];
      for (let index = 0; index < values.length; index += 1) {
        pageItems.push(options.mapItem ? options.mapItem(values[index], items.length + index) : values[index] as T);
      }
      items.push(...pageItems);
      next = pagingLink(page);
      if (!next) return { items, pages, complete: true, truncated: false, nextPage: null, errors };
      if (pages >= maxPages) break;
      const url = nextUrl(next, target.url, options.initial);
      if (!url) return { items, pages, complete: true, truncated: false, nextPage: null, errors };
      target = { ...target, url };
    } catch (error) {
      return finishPartial(error);
    }
  }
  const limitError = new ClassicApiError('PARTIAL_RESULTS', 'Blackboard 分页达到本次读取上限。', { scope: `pagination:${options.initial.resource}` });
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
