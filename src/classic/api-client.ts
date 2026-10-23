import { debugLog } from '../debug-log.js';
import { ClassicApiError, publicApiError } from './api-errors.js';
import type { ClassicApiCallOptions, ClassicApiResponse, ClassicApiTransport, ClassicRequestBudget, ClassicSession as ClassicSessionContract } from './api-contract.js';
import { ClassicEndpointRegistry, type ClassicEndpointTarget, type CollectionQuery } from './endpoints.js';
import { createRequestBudget, paginateCollection, type PaginatedResult } from './pagination.js';
import {
  collectionItems,
  RawAnnouncementSchema,
  RawAttemptSchema,
  RawCalendarItemSchema,
  RawCollectionSchema,
  RawContentNodeSchema,
  RawCourseSchema,
  RawFileSchema,
  RawGradeColumnSchema,
  RawGradeSchema,
  RawObjectSchema,
  rawId,
  rawRecord,
  rawString,
  type RawAnnouncement,
  type RawAttempt,
  type RawCalendarItem,
  type RawContentNode,
  type RawCourse,
  type RawFile,
  type RawGrade,
  type RawGradeColumn,
  type RawObject,
} from './raw-schema.js';

export type { ClassicApiCallOptions } from './api-contract.js';

export interface ClassicApiClientOptions {
  readonly transport: ClassicApiTransport;
  readonly session: ClassicSessionContract;
  readonly endpoints?: ClassicEndpointRegistry;
}

function record(value: unknown, scope: string): RawObject {
  const parsed = RawObjectSchema.safeParse(value);
  if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 对象响应无法识别。', { scope, cause: parsed.error });
  return parsed.data;
}

function courseRecord(value: unknown, courseId: string, scope: string, verifyRecordId = false): RawObject {
  const item = record(value, scope);
  const presentCourseId = rawId(item, 'courseId');
  const presentRecordId = verifyRecordId ? rawId(item, 'id') : null;
  if ((presentCourseId && presentCourseId !== courseId) || (presentRecordId && presentRecordId !== courseId)) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 返回了其他课程的数据。', { scope, retryable: false });
  }
  return { ...item, courseId };
}

function callBudget(options: ClassicApiCallOptions): ClassicRequestBudget {
  return options.budget ?? createRequestBudget(options.signal);
}

function requestFor(target: ClassicEndpointTarget, options: ClassicApiCallOptions): Parameters<ClassicApiTransport['request']>[0] {
  return {
    method: 'GET',
    url: target.url,
    resource: target.resource,
    ...(target.courseId ? { courseId: target.courseId } : {}),
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...(options.allowReservedBudget ? { allowReservedBudget: true } : {}),
    budget: callBudget(options),
  };
}

export class ClassicApiClient {
  readonly endpoints: ClassicEndpointRegistry;

  constructor(private readonly options: ClassicApiClientOptions) {
    this.endpoints = options.endpoints ?? new ClassicEndpointRegistry();
  }

  /** The account context is session-owned and never accepted from callers. */
  get account(): ClassicSessionContract['account'] { return this.options.session.account; }
  get session(): ClassicSessionContract { return this.options.session; }

  /**
   * API calls run inside the caller's request budget.  Authentication
   * verification is deliberately a provider/session concern; calling the
   * session's network probe here for every endpoint would create an
   * unaccounted second budget after its short auth cache expires.  The first
   * identity request and the final identity recheck in the snapshot reader
   * are the bounded on-budget verification points.
   */
  private ensure(options: ClassicApiCallOptions): void {
    if (options.signal.aborted || options.budget?.signal.aborted) {
      throw new ClassicApiError('TIMEOUT', 'Classic API 操作已取消。', { scope: 'api.session', retryable: false });
    }
    const state = this.options.session.state;
    if (state === 'authenticated' && this.options.session.account) return;
    const code = state === 'expired' ? 'SESSION_EXPIRED' : state === 'unknown' ? 'TIMEOUT' : 'AUTH_REQUIRED';
    const message = code === 'SESSION_EXPIRED' ? 'Classic 会话已过期。' : code === 'TIMEOUT' ? 'Classic 会话检查未完成。' : 'Classic 会话尚未确认。';
    throw new ClassicApiError(code, message, { scope: 'api.session', retryable: code === 'TIMEOUT' });
  }

  private async request<T>(target: ClassicEndpointTarget, options: ClassicApiCallOptions): Promise<ClassicApiResponse<T>> {
    const response = await this.options.transport.request<T>(requestFor(target, options));
    if (response.data === null && target.resource !== 'attachments') throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 响应缺少数据。', { scope: `api:${target.resource}` });
    return response;
  }

  private async page<T>(target: ClassicEndpointTarget, options: ClassicApiCallOptions, parse: (value: unknown, index: number) => T, maxPages = 20): Promise<PaginatedResult<T>> {
    const result = await paginateCollection({
      transport: this.options.transport,
      initial: target,
      budget: callBudget(options),
      traceId: options.traceId,
      maxPages,
      mapItem: parse,
    });
    debugLog.event('classic.api.client.page', {
      traceId: options.traceId,
      resource: target.resource,
      courseId: target.courseId,
      pages: result.pages,
      received: result.items.length,
      complete: result.complete,
      truncated: result.truncated,
      errorCount: result.errors.length,
      errorCodes: result.errors.slice(0, 8).map(error => error.code),
      errorScopes: result.errors.slice(0, 8).map(error => error.scope),
    });
    return result;
  }

  async identity(options: ClassicApiCallOptions): Promise<RawObject> {
    await this.ensure(options);
    return record((await this.request<unknown>(this.endpoints.identity(), options)).data, 'api.identity');
  }

  async memberships(options: ClassicApiCallOptions, query?: CollectionQuery): Promise<PaginatedResult<RawObject>> {
    await this.ensure(options);
    return this.page(this.endpoints.memberships(query), options, value => record(value, 'api.memberships'));
  }

  async courses(options: ClassicApiCallOptions, query?: CollectionQuery): Promise<PaginatedResult<RawCourse>> {
    await this.ensure(options);
    return this.page(this.endpoints.memberships(query), options, value => {
      const membership = record(value, 'api.memberships');
      const course = membership.course ?? membership;
      const parsed = RawCourseSchema.safeParse(course);
      if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard membership 缺少课程结构。', { scope: 'api.courses', cause: parsed.error });
      return parsed.data;
    });
  }

  async course(options: ClassicApiCallOptions, courseId: string): Promise<RawCourse> {
    await this.ensure(options);
    const parsed = RawCourseSchema.safeParse(courseRecord((await this.request<unknown>(this.endpoints.course(courseId), options)).data, courseId, `api.course:${courseId}`, true));
    if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 课程结构无法识别。', { scope: `course:${courseId}`, cause: parsed.error });
    return parsed.data;
  }

  async announcements(options: ClassicApiCallOptions, courseId: string, query?: CollectionQuery): Promise<PaginatedResult<RawAnnouncement>> {
    await this.ensure(options);
    return this.page(this.endpoints.announcements(courseId, query), options, value => RawAnnouncementSchema.parse(courseRecord(value, courseId, `api.announcements:${courseId}`)));
  }

  async contents(options: ClassicApiCallOptions, courseId: string, contentId?: string, query?: CollectionQuery, maxPages = 20): Promise<PaginatedResult<RawContentNode>> {
    await this.ensure(options);
    return this.page(this.endpoints.contents(courseId, contentId, query), options, value => RawContentNodeSchema.parse(courseRecord(value, courseId, `api.contents:${courseId}`)), maxPages);
  }

  async contentDetail(options: ClassicApiCallOptions, courseId: string, contentId: string): Promise<RawContentNode> {
    await this.ensure(options);
    const raw = courseRecord((await this.request<unknown>(this.endpoints.contentDetail(courseId, contentId), options)).data, courseId, `api.content:${contentId}`);
    const returnedContentId = rawId(raw, 'contentId', 'id');
    if (returnedContentId && returnedContentId !== contentId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 内容详情归属不一致。', { scope: `content:${contentId}`, retryable: false });
    const parsed = RawContentNodeSchema.safeParse(raw);
    if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 内容详情结构无法识别。', { scope: `content:${contentId}`, cause: parsed.error });
    return parsed.data;
  }

  async gradeColumns(options: ClassicApiCallOptions, courseId: string, query?: CollectionQuery): Promise<PaginatedResult<RawGradeColumn>> {
    await this.ensure(options);
    return this.page(this.endpoints.gradeColumns(courseId, query), options, value => RawGradeColumnSchema.parse(courseRecord(value, courseId, `api.grade-columns:${courseId}`)));
  }

  async grades(options: ClassicApiCallOptions, courseId: string, userId?: string, query?: CollectionQuery): Promise<PaginatedResult<RawGrade>> {
    await this.ensure(options);
    const accountUserId = this.options.session.account?.userId;
    const resolvedUserId = userId ?? accountUserId;
    if (!resolvedUserId) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话缺少当前用户 ID。', { scope: `grades:${courseId}`, retryable: false });
    if (accountUserId && userId && userId !== accountUserId) throw new ClassicApiError('BAD_INPUT', '成绩读取只能使用当前登录用户。', { scope: `grades:${courseId}`, retryable: false });
    return this.page(this.endpoints.grades(courseId, resolvedUserId, query), options, value => {
      const item = courseRecord(value, courseId, `api.grades:${courseId}`);
      const nestedUser = rawRecord(item.user);
      const returnedUserId = rawString(item.userId ?? nestedUser?.id ?? item.studentId);
      if (returnedUserId && returnedUserId !== resolvedUserId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 成绩返回了其他用户的数据。', { scope: `api.grades:${courseId}`, retryable: false });
      return RawGradeSchema.parse(item);
    });
  }

  async attempts(options: ClassicApiCallOptions, courseId: string, columnId: string, gradeId: string, query?: CollectionQuery): Promise<PaginatedResult<RawAttempt>> {
    await this.ensure(options);
    return this.page(this.endpoints.attempts(courseId, columnId, gradeId, query), options, value => {
      const item = courseRecord(value, courseId, `api.attempts:${courseId}`);
      const returnedColumnId = rawId(item, 'columnId');
      const returnedGradeId = rawId(item, 'gradeId');
      if (returnedColumnId && returnedColumnId !== columnId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard attempt 返回了其他评分列。', { scope: `api.attempts:${courseId}`, retryable: false });
      if (returnedGradeId && returnedGradeId !== gradeId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard attempt 返回了其他成绩记录。', { scope: `api.attempts:${courseId}`, retryable: false });
      return RawAttemptSchema.parse({ ...item, columnId, gradeId });
    });
  }

  async attemptDetail(options: ClassicApiCallOptions, courseId: string, attemptId: string): Promise<RawAttempt> {
    await this.ensure(options);
    const raw = courseRecord((await this.request<unknown>(this.endpoints.attemptDetail(courseId, attemptId), options)).data, courseId, `api.attempt:${attemptId}`);
    const returnedAttemptId = rawId(raw, 'attemptId', 'id');
    if (returnedAttemptId && returnedAttemptId !== attemptId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard attempt 详情归属不一致。', { scope: `attempt:${attemptId}`, retryable: false });
    const parsed = RawAttemptSchema.safeParse(raw);
    if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard attempt 详情结构无法识别。', { scope: `attempt:${attemptId}`, cause: parsed.error });
    return parsed.data;
  }

  async calendar(options: ClassicApiCallOptions, since: string, until: string, query?: CollectionQuery): Promise<PaginatedResult<RawCalendarItem>> {
    await this.ensure(options);
    // Validate both dates before the first request, then cover the entire
    // requested interval with adjacent, inclusive two-week windows. Internal
    // calendar navigation is not ordinary offset-based collection paging.
    this.endpoints.calendar(since, until, query);
    const rangeEnd = Date.parse(until);
    let cursor = Date.parse(since);
    if (cursor > rangeEnd) throw new ClassicApiError('BAD_INPUT', '日历起始时间不能晚于结束时间。', { scope: 'api.calendar', retryable: false });
    const scopedOptions = { ...options, budget: callBudget(options) };
    const items: RawCalendarItem[] = [];
    const seen = new Set<string>();
    const errors: PaginatedResult<RawCalendarItem>['errors'][number][] = [];
    let pages = 0, complete = false, truncated = false, nextPage: string | null = null;
    let windows = 0;
    do {
      const end = Math.min(cursor + 14 * 86400000, rangeEnd);
      const target = this.endpoints.calendar(new Date(cursor).toISOString(), new Date(end).toISOString(), query);
      if (pages >= 20) {
        truncated = true;
        nextPage = target.url.href;
        errors.push(publicApiError(new ClassicApiError('PARTIAL_RESULTS', '日历时间段读取达到本次上限。', { scope: 'pagination:calendar', retryable: false })));
        break;
      }
      const window = await this.page(target, scopedOptions, value => RawCalendarItemSchema.parse(record(value, 'api.calendar')), 20 - pages);
      windows++;
      pages += window.pages;
      for (const item of window.items) {
        // Identical boundary rows are shared by adjacent inclusive windows.
        // Keep changed records, including conflicting deadline evidence.
        const key = JSON.stringify(item);
        if (!seen.has(key)) { seen.add(key); items.push(item); }
      }
      errors.push(...window.errors);
      if (!window.complete) { truncated = window.truncated || end < rangeEnd; nextPage = window.nextPage; break; }
      if (end === rangeEnd) { complete = true; break; }
      cursor = end;
    } while (true);
    const result: PaginatedResult<RawCalendarItem> = { items, pages, complete, truncated, nextPage, errors };
    debugLog.event('classic.api.calendar.windows', { traceId: options.traceId, windows, pages, received: items.length, complete, truncated, errorCount: errors.length });
    let gradebookColumnCount = 0;
    let knownNonGradebookCount = 0;
    let unknownTypeCount = 0;
    let unboundCount = 0;
    for (const item of result.items) {
      const value = item as RawObject;
      const type = rawString(value.type)?.toLowerCase();
      if (type === 'gradebookcolumn') gradebookColumnCount += 1;
      else if (type) knownNonGradebookCount += 1;
      else unknownTypeCount += 1;
      if (!rawId(value, 'courseId')) unboundCount += 1;
    }
    debugLog.event('classic.api.calendar.shape-summary', {
      traceId: options.traceId,
      itemCount: result.items.length,
      gradebookColumnCount,
      knownNonGradebookCount,
      unknownTypeCount,
      unboundCount,
      complete: result.complete,
      errorCount: result.errors.length,
    });
    return result;
  }

  async attachments(options: ClassicApiCallOptions, courseId: string, contentId: string, query?: CollectionQuery): Promise<PaginatedResult<RawFile>> {
    await this.ensure(options);
    return this.page(this.endpoints.attachments(courseId, contentId, query), options, value => {
      const item = record(value, `attachments:${contentId}`);
      const courseScoped = courseRecord(item, courseId, `attachments:${contentId}`);
      const returnedContentId = rawId(courseScoped, 'contentId');
      if (returnedContentId && returnedContentId !== contentId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 附件返回了其他内容。', { scope: `attachments:${contentId}`, retryable: false });
      const parsed = RawFileSchema.safeParse({ ...courseScoped, contentId });
      if (!parsed.success) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 公开附件结构无法识别。', { scope: `attachments:${contentId}`, cause: parsed.error });
      return parsed.data;
    });
  }

  async attachmentHead(options: ClassicApiCallOptions, courseId: string, contentId: string, attachmentId: string): Promise<ClassicApiResponse<null>> {
    await this.ensure(options);
    const endpoint = this.endpoints.attachmentDownload(courseId, contentId, attachmentId);
    const request = { ...requestFor(endpoint, options), method: 'HEAD' as const };
    return this.options.transport.request<null>(request);
  }

  async systemVersion(options: ClassicApiCallOptions): Promise<RawObject> {
    await this.ensure(options);
    const response = await this.request<unknown>(this.endpoints.systemVersion(), options);
    return record(response.data, 'api.system-version');
  }
}
