import { ClassicApiError } from './api-errors.js';
import { CLASSIC_API_ORIGIN, type ClassicApiOrigin, type ClassicApiResource } from './api-contract.js';

export interface ClassicEndpointTarget {
  readonly url: URL;
  readonly resource: ClassicApiResource;
  readonly courseId?: string;
  /** Exact collection pathname used to validate pagination links before the next GET. */
  readonly familyPrefix: string;
}

export interface CollectionQuery {
  readonly limit?: number;
  readonly offset?: number;
}

function id(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 || /[\u0000-\u001f\u007f/\\?#]/.test(value)) {
    throw new ClassicApiError('BAD_INPUT', `${label} 无效。`, { scope: `endpoint.${label}`, retryable: false });
  }
  return value.trim();
}

function bounded(value: number | undefined, fallback: number, max: number): string {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 1 || number > max) throw new ClassicApiError('BAD_INPUT', 'API 分页参数超出范围。', { scope: 'endpoint.pagination', retryable: false });
  return String(number);
}

function dateParameter(value: string, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (!match) {
    throw new ClassicApiError('BAD_INPUT', `${label} 必须是有效 ISO 日期时间。`, { scope: `endpoint.${label}`, retryable: false });
  }
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || day < 1 || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day || !Number.isFinite(Date.parse(text))) {
    throw new ClassicApiError('BAD_INPUT', `${label} 必须是有效 ISO 日期时间。`, { scope: `endpoint.${label}`, retryable: false });
  }
  return text;
}

function target(origin: ClassicApiOrigin, path: string, resource: ClassicApiResource, courseId?: string, familyPrefix = path): ClassicEndpointTarget {
  const url = new URL(path, origin);
  return { url, resource, ...(courseId ? { courseId } : {}), familyPrefix };
}

function collectionTarget(origin: ClassicApiOrigin, path: string, resource: ClassicApiResource, query: CollectionQuery | undefined, courseId?: string, familyPrefix = path): ClassicEndpointTarget {
  const endpoint = target(origin, path, resource, courseId, familyPrefix);
  endpoint.url.searchParams.set('limit', bounded(query?.limit, 100, 1000));
  if (query?.offset !== undefined) {
    if (!Number.isInteger(query.offset) || query.offset < 0 || query.offset > 1_000_000) throw new ClassicApiError('BAD_INPUT', 'API offset 无效。', { scope: 'endpoint.pagination', retryable: false });
    endpoint.url.searchParams.set('offset', String(query.offset));
  }
  return endpoint;
}

function coursePath(courseId: string, suffix: string): { courseId: string; path: string; familyPrefix: string } {
  const safeCourseId = id(courseId, 'courseId');
  const prefix = `/learn/api/v1/courses/${encodeURIComponent(safeCourseId)}`;
  return { courseId: safeCourseId, path: `${prefix}${suffix}`, familyPrefix: `${prefix}${suffix.split('?')[0]}` };
}

/** Reviewed CUHK(SZ) Classic JSON API endpoint registry. */
export class ClassicEndpointRegistry {
  readonly origin: ClassicApiOrigin;

  constructor(origin: string = CLASSIC_API_ORIGIN) {
    const parsed = new URL(origin);
    if (parsed.origin !== CLASSIC_API_ORIGIN || parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.port) {
      throw new ClassicApiError('URL_REJECTED', 'Classic API 仅允许固定学校 HTTPS origin。', { scope: 'endpoint.origin', retryable: false });
    }
    this.origin = parsed.origin as ClassicApiOrigin;
  }

  identity(): ClassicEndpointTarget {
    return target(this.origin, '/learn/api/v1/users/me', 'identity', undefined, '/learn/api/v1/users/me');
  }

  memberships(query?: CollectionQuery): ClassicEndpointTarget {
    const endpoint = collectionTarget(this.origin, '/learn/api/v1/users/me/memberships', 'memberships', query, undefined, '/learn/api/v1/users/me/memberships');
    endpoint.url.searchParams.set('expand', 'course');
    return endpoint;
  }

  course(courseId: string): ClassicEndpointTarget {
    const value = coursePath(courseId, '');
    return target(this.origin, value.path, 'courses', value.courseId, value.familyPrefix);
  }

  announcements(courseId: string, query?: CollectionQuery): ClassicEndpointTarget {
    const value = coursePath(courseId, '/announcements');
    return collectionTarget(this.origin, value.path, 'announcements', query, value.courseId, value.familyPrefix);
  }

  contents(courseId: string, contentId?: string, query?: CollectionQuery): ClassicEndpointTarget {
    const value = coursePath(courseId, contentId ? `/contents/${encodeURIComponent(id(contentId, 'contentId'))}/children` : '/contents/ROOT/children');
    return collectionTarget(this.origin, value.path, 'contents', query, value.courseId, value.path);
  }

  contentDetail(courseId: string, contentId: string): ClassicEndpointTarget {
    const value = coursePath(courseId, `/contents/${encodeURIComponent(id(contentId, 'contentId'))}`);
    return target(this.origin, value.path, 'contents', value.courseId, value.path);
  }

  gradeColumns(courseId: string, query?: CollectionQuery): ClassicEndpointTarget {
    const value = coursePath(courseId, '/gradebook/columns');
    return collectionTarget(this.origin, value.path, 'grades', query, value.courseId, value.familyPrefix);
  }

  grades(courseId: string, userId: string, query?: CollectionQuery): ClassicEndpointTarget {
    const value = coursePath(courseId, '/gradebook/grades');
    const endpoint = collectionTarget(this.origin, value.path, 'grades', query, value.courseId, value.familyPrefix);
    endpoint.url.searchParams.set('userId', id(userId, 'userId'));
    endpoint.url.searchParams.set('expand', 'lastAttempt,column');
    return endpoint;
  }

  attempts(courseId: string, columnId: string, gradeId: string, query?: CollectionQuery): ClassicEndpointTarget {
    const value = coursePath(courseId, `/gradebook/columns/${encodeURIComponent(id(columnId, 'columnId'))}/grades/${encodeURIComponent(id(gradeId, 'gradeId'))}/attempts`);
    return collectionTarget(this.origin, value.path, 'attempts', query, value.courseId, value.familyPrefix);
  }

  attemptDetail(courseId: string, attemptId: string): ClassicEndpointTarget {
    const value = coursePath(courseId, `/gradebook/attempts/${encodeURIComponent(id(attemptId, 'attemptId'))}`);
    const endpoint = target(this.origin, value.path, 'attempts', value.courseId, value.familyPrefix);
    endpoint.url.searchParams.set('expand', 'attemptReceipt.lateSubmission');
    return endpoint;
  }

  calendar(since: string, until: string, query?: CollectionQuery): ClassicEndpointTarget {
    const endpoint = collectionTarget(this.origin, '/learn/api/v1/calendars/calendarItems', 'calendar', query, undefined, '/learn/api/v1/calendars/calendarItems');
    endpoint.url.searchParams.set('since', dateParameter(since, 'since'));
    endpoint.url.searchParams.set('until', dateParameter(until, 'until'));
    return endpoint;
  }

  attachments(courseId: string, contentId: string, query?: CollectionQuery): ClassicEndpointTarget {
    const value = coursePath(courseId, `/contents/${encodeURIComponent(id(contentId, 'contentId'))}/attachments`);
    const path = `/learn/api/public/v1/courses/${encodeURIComponent(value.courseId)}/contents/${encodeURIComponent(id(contentId, 'contentId'))}/attachments`;
    return collectionTarget(this.origin, path, 'attachments', query, value.courseId, `/learn/api/public/v1/courses/${encodeURIComponent(value.courseId)}/contents/${encodeURIComponent(id(contentId, 'contentId'))}/attachments`);
  }

  attachmentDownload(courseId: string, contentId: string, attachmentId: string): ClassicEndpointTarget {
    const safeCourseId = id(courseId, 'courseId');
    const safeContentId = id(contentId, 'contentId');
    const safeAttachmentId = id(attachmentId, 'attachmentId');
    const path = `/learn/api/public/v1/courses/${encodeURIComponent(safeCourseId)}/contents/${encodeURIComponent(safeContentId)}/attachments/${encodeURIComponent(safeAttachmentId)}/download`;
    return target(this.origin, path, 'attachments', safeCourseId, `/learn/api/public/v1/courses/${encodeURIComponent(safeCourseId)}/contents/${encodeURIComponent(safeContentId)}/attachments`);
  }

  systemVersion(): ClassicEndpointTarget {
    return target(this.origin, '/learn/api/public/v1/system/version', 'version', undefined, '/learn/api/public/v1/system/version');
  }
}
