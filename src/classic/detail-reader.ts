import { debugLog } from '../debug-log.js';
import { ClassicApiError, isAuthenticationError, publicApiError, type PublicClassicApiError } from './api-errors.js';
import type { ClassicApiClient } from './api-client.js';
import type { ClassicApiCallOptions } from './api-contract.js';
import { rawId, rawRecord, rawString, type RawContentNode, type RawFile } from './raw-schema.js';
import { sanitizeRichBody } from './rich-text.js';
import { AssignmentV2Schema, emptyRichBody, type AssignmentV2, type AttachmentV2, type RichBody } from './schema-v2.js';
import { CLASSIC_API_ORIGIN } from './api-contract.js';

export interface ClassicCachedResource {
  readonly resourceId: string;
  readonly url: string;
  readonly kind: 'image' | 'attachment';
  readonly courseId?: string;
  readonly contentId?: string;
  readonly sourcePageUrl?: string;
  readonly resourceKey?: string;
  readonly mimeType: string | null;
  readonly maxBytes: number;
}

export interface ClassicResourceRegistrar {
  register(options: {
    readonly url: string | URL;
    readonly kind?: 'image' | 'attachment';
    readonly courseId?: string;
    readonly contentId?: string;
    readonly mimeType?: string | null;
    readonly traceId?: string;
    /** Same-course page used only for lazy resolution of a bare bbcswebdav xid/rid. */
    readonly sourcePageUrl?: string | URL;
    readonly resourceKey?: string;
  }): string | null;
  snapshotCachedResources?(resourceIds: readonly string[]): readonly ClassicCachedResource[];
  restoreCachedResources?(resources: readonly ClassicCachedResource[]): ReadonlyMap<string, string>;
}

export interface AssignmentDetailResult {
  readonly state: 'ok' | 'partial' | 'unsupported' | 'failed';
  readonly assignment: AssignmentV2;
  readonly content: { readonly contentId: string; readonly title: string; readonly details: RichBody | null } | null;
  readonly attachments: readonly AttachmentV2[];
  readonly errors: readonly PublicClassicApiError[];
}

export interface AssignmentDetailOptions extends ClassicApiCallOptions {
  readonly resourceRegistry?: ClassicResourceRegistrar;
}

function richBody(value: unknown, options: AssignmentDetailOptions, baseUrl?: string, courseId?: string, contentId?: string): RichBody | null {
  if (value === undefined || value === null) return null;
  try {
    return sanitizeRichBody(value, {
      baseUrl,
      registerImage: (url, alt) => {
        const resourceId = options.resourceRegistry?.register({ kind: 'image', url, courseId, contentId, traceId: options.traceId });
        return resourceId ? { resourceId, alt } : null;
      },
    });
  } catch {
    if (typeof value === 'string') return emptyRichBody(value, false);
    return null;
  }
}

function safeSourceUrl(value: unknown): string | null {
  const text = rawString(value);
  if (!text) return null;
  try {
    const url = new URL(text, 'https://bb.cuhk.edu.cn');
    if (url.origin !== 'https://bb.cuhk.edu.cn' || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    return url.href;
  } catch { return null; }
}

function attachmentDownloadUrl(courseId: string, contentId: string, attachmentId: string): string {
  const url = new URL(
    `/learn/api/public/v1/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
    CLASSIC_API_ORIGIN,
  );
  return url.href;
}

function contentSourceUrl(courseId: string, contentId: string): string {
  const url = new URL('/webapps/blackboard/content/listContent.jsp', CLASSIC_API_ORIGIN);
  url.searchParams.set('course_id', courseId);
  url.searchParams.set('content_id', contentId);
  return url.href;
}

function attachmentFrom(courseId: string, contentId: string, value: RawFile, options: AssignmentDetailOptions): AttachmentV2 | null {
  const item = value as Record<string, unknown>;
  const id = rawId(item, 'attachmentId', 'id');
  const name = rawString(item.name ?? item.title ?? item.fileName);
  if (!id || !name) return null;
  const url = safeSourceUrl(item.url ?? item.webLocation ?? item.permanentUrl);
  // Persist the stable public download entry. The response URL is retained
  // only in the in-memory registry and may contain a temporary signature.
  const persistentUrl = attachmentDownloadUrl(courseId, contentId, id);
  let resourceId: string | null = null;
  if (url && options.resourceRegistry) {
    try {
      resourceId = options.resourceRegistry.register({ kind: 'attachment', url, courseId, contentId, mimeType: rawString(item.mimeType ?? item.contentType) ?? null, traceId: options.traceId });
    } catch { resourceId = null; }
  }
  return { id, name, mimeType: rawString(item.mimeType ?? item.contentType) ?? null, url: persistentUrl, resourceId };
}

function detailContent(courseId: string, content: RawContentNode, options: AssignmentDetailOptions): { contentId: string; title: string; details: RichBody | null } {
  const item = content as Record<string, unknown>;
  const contentId = rawId(item, 'contentId', 'id');
  if (!contentId) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 作业详情缺少 content ID。', { scope: `assignment:${courseId}` });
  const baseUrl = safeSourceUrl(item.url ?? item.webLocation ?? item.permanentUrl) ?? contentSourceUrl(courseId, contentId);
  return { contentId, title: rawString(item.title ?? item.name) ?? '', details: richBody(item.body ?? item.description ?? item.details, options, baseUrl, courseId, contentId) };
}

function mergeAttachments(current: readonly AttachmentV2[], additions: readonly AttachmentV2[]): AttachmentV2[] {
  const output = [...current];
  const seen = new Set(output.map(item => item.id));
  for (const item of additions) if (!seen.has(item.id)) { seen.add(item.id); output.push(item); }
  return output;
}

/** Read assignment details and public attachment metadata through fixed API endpoints. */
export async function readAssignmentDetail(api: ClassicApiClient, assignment: AssignmentV2, options: AssignmentDetailOptions): Promise<AssignmentDetailResult> {
  const started = Date.now();
  const contentId = assignment.contentId;
  if (!contentId) {
    const error = new ClassicApiError('ENDPOINT_UNSUPPORTED', '当前作业没有可验证的 content ID，详情暂不可读。', { scope: `assignment:${assignment.id}`, retryable: false });
    return { state: 'unsupported', assignment, content: null, attachments: assignment.attachments, errors: [error.toPublic()] };
  }
  let detail: { contentId: string; title: string; details: RichBody | null };
  try {
    detail = detailContent(assignment.courseId, await api.contentDetail(options, assignment.courseId, contentId), options);
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    debugLog.event('classic.api.detail.error', { traceId: options.traceId, courseId: assignment.courseId, contentId, elapsedMs: Date.now() - started, errorCode: publicApiError(error).code });
    return { state: 'failed', assignment, content: null, attachments: assignment.attachments, errors: [publicApiError(error)] };
  }

  let attachments = assignment.attachments;
  const errors: PublicClassicApiError[] = [];
  try {
    const result = await api.attachments(options, assignment.courseId, contentId, { limit: 100 });
    const values = result.items.map(item => attachmentFrom(assignment.courseId, contentId, item, options)).filter((value): value is AttachmentV2 => !!value);
    const droppedItems = result.items.length !== values.length;
    if (droppedItems) errors.push(publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', '作业附件返回了无法识别的项目，已保留旧数据缺口。', { scope: `assignment:${assignment.id}:attachments`, retryable: false })));
    attachments = result.complete && !droppedItems ? values : mergeAttachments(assignment.attachments, values);
    errors.push(...result.errors);
    if (!result.complete && !result.errors.some(error => error.code === 'PARTIAL_RESULTS')) {
      errors.push(publicApiError(new ClassicApiError('PARTIAL_RESULTS', '作业附件列表未完整读取。', { scope: `assignment:${assignment.id}:attachments`, retryable: false })));
    }
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    errors.push(publicApiError(error));
  }
  const updated = AssignmentV2Schema.parse({ ...assignment, details: detail.details, attachments });
  debugLog.event('classic.api.detail.done', { traceId: options.traceId, courseId: assignment.courseId, contentId, elapsedMs: Date.now() - started, attachmentCount: attachments.length, errorCount: errors.length });
  return { state: errors.length ? 'partial' : 'ok', assignment: updated, content: detail, attachments, errors };
}
