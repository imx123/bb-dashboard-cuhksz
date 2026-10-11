import { randomUUID } from 'node:crypto';
import { debugLog } from '../debug-log.js';
import { CLASSIC_API_ORIGIN, type ClassicApiTransport, type TraceId } from './api-contract.js';
import { ClassicApiError } from './api-errors.js';
import type { ClassicSession } from './session.js';
import { extractBbcsWebDavImageSources, inspectBbcsWebDavSource, safeBbcsWebDavSourcePage } from './bbcswebdav.js';
import type { ClassicCachedResource } from './detail-reader.js';

export const CLASSIC_RESOURCE_SCHEME = 'lms-resource';
const RESOURCE_HOST = 'resource';
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;
// ClassicHttpClient counts each redirect hop against requestLimit. Keep the
// attachment budget bounded while allowing its known same-origin 302 chain:
// three attempts (initial + two retries) times six hops (initial + five 302s).
const RESOURCE_REQUEST_LIMIT = 18;
const MAX_SOURCE_PAGE_CONTEXTS = 64;

const SAFE_MEDIA_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'application/pdf', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed',
  'text/plain', 'text/csv',
]);
const SAFE_IMAGE_TYPES = new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);
const SENSITIVE_CACHE_QUERY = /(?:token|ticket|code|saml|relay|state|session|jsession|cookie|auth|password|secret|signature|assertion|credential|nonce|key|otp|mfa)/i;

type SourcePageCandidates = Map<string, ReadonlySet<string>>;

interface ResourceEntry {
  readonly resourceId: string;
  url: URL;
  readonly generation: number;
  readonly kind: 'image' | 'attachment';
  readonly courseId?: string;
  readonly contentId?: string;
  readonly sourcePageUrl?: URL;
  readonly resourceKey?: string;
  readonly mimeType: string | null;
  readonly maxBytes: number;
  readonly traceId?: TraceId;
}

export interface RegisterClassicResourceOptions {
  readonly url: string | URL;
  readonly courseId?: string;
  readonly contentId?: string;
  /** Image entries can only be served with a safe non-SVG image MIME. */
  readonly kind?: 'image' | 'attachment';
  readonly mimeType?: string | null;
  readonly maxBytes?: number;
  readonly traceId?: TraceId;
  /** Same-course page and exact xid/rid key for lazy prefix resolution. */
  readonly sourcePageUrl?: string | URL;
  readonly resourceKey?: string;
}

export interface ReadClassicResourceOptions {
  readonly method?: 'GET' | 'HEAD';
  readonly signal?: AbortSignal;
  readonly traceId?: TraceId;
  /** Typed callers must state whether they expect an image or an attachment. */
  readonly expectedKind?: 'image' | 'attachment';
}

export interface ClassicResourceReadResult {
  readonly resourceId: string;
  readonly status: number;
  readonly mimeType: string;
  readonly body: Uint8Array | null;
}

function safeSourceUrl(value: string | URL): URL | null {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    if (url.protocol !== 'https:' || url.origin !== CLASSIC_API_ORIGIN || url.username || url.password || url.port || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function cacheableUrl(value: string | URL): string | null {
  const url = safeSourceUrl(value);
  if (!url) return null;
  for (const [key] of url.searchParams) if (SENSITIVE_CACHE_QUERY.test(key)) return null;
  return url.href;
}

function safeResourceId(value: string): boolean {
  return /^[a-f0-9-]{20,80}$/i.test(value);
}

function boundedBytes(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  return Math.max(1, Math.min(MAX_RESOURCE_BYTES, Math.floor(value!)));
}

function contentType(value: string | null | undefined): string | null {
  const type = (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!type || !SAFE_MEDIA_TYPES.has(type)) return null;
  return type;
}

/**
 * Main-process registry for images and attachments referenced by RichBody.
 * Renderer code sees only a random resource ID and an opaque DTO URL. Media
 * bytes are returned through typed main-process IPC; no custom protocol is
 * registered for renderer requests.
 */
export class ClassicResourceRegistry {
  private readonly entries = new Map<string, ResourceEntry>();
  private readonly sourcePageContexts = new Map<string, Promise<SourcePageCandidates>>();

  constructor(
    private readonly session: ClassicSession,
    private readonly transport: ClassicApiTransport,
  ) {}

  register(options: RegisterClassicResourceOptions): string | null {
    this.clearStale();
    if (this.session.state !== 'authenticated' || !this.session.account || this.session.account.sessionGeneration !== this.session.generation) return null;
    const url = safeSourceUrl(options.url);
    if (!url) return null;
    const inspected = options.kind === 'image' ? inspectBbcsWebDavSource(url) : null;
    const sourcePageUrl = options.sourcePageUrl && options.courseId
      ? safeBbcsWebDavSourcePage(options.sourcePageUrl, options.courseId, options.contentId)
      : null;
    const resourceKey = inspected && !inspected.prefixed && sourcePageUrl && typeof options.resourceKey === 'string' && options.resourceKey.toLowerCase() === inspected.key
      ? inspected.key
      : undefined;
    const registeredMime = contentType(options.mimeType);
    const resourceId = randomUUID();
    const entry: ResourceEntry = {
      resourceId,
      url,
      generation: this.session.generation,
      // Explicit kind is authoritative. Keep the narrow inference only for
      // callers that predate the typed registrar contract.
      kind: options.kind ?? (registeredMime?.startsWith('image/') || (!options.courseId && !options.contentId) ? 'image' : 'attachment'),
      ...(options.courseId ? { courseId: options.courseId } : {}),
      ...(options.contentId ? { contentId: options.contentId } : {}),
      ...(sourcePageUrl && resourceKey ? { sourcePageUrl, resourceKey } : {}),
      mimeType: registeredMime,
      maxBytes: boundedBytes(options.maxBytes),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    };
    this.entries.set(resourceId, entry);
    return resourceId;
  }

  clear(): void {
    this.entries.clear();
    this.sourcePageContexts.clear();
  }

  clearStale(): void {
    const generation = this.session.generation;
    for (const [resourceId, entry] of this.entries) if (entry.generation !== generation) this.entries.delete(resourceId);
    const prefix = `${generation}:`;
    for (const key of this.sourcePageContexts.keys()) if (!key.startsWith(prefix)) this.sourcePageContexts.delete(key);
  }

  resourceUrl(resourceId: string): string | null {
    this.clearStale();
    const entry = this.entries.get(resourceId);
    if (!safeResourceId(resourceId) || !entry || entry.kind !== 'image') return null;
    return `${CLASSIC_RESOURCE_SCHEME}://${RESOURCE_HOST}/${encodeURIComponent(resourceId)}`;
  }

  snapshotCachedResources(resourceIds: readonly string[]): readonly ClassicCachedResource[] {
    this.clearStale();
    const output: ClassicCachedResource[] = [];
    const seen = new Set<string>();
    for (const resourceId of resourceIds) {
      if (seen.has(resourceId)) continue;
      seen.add(resourceId);
      const entry = this.entries.get(resourceId);
      const url = entry ? cacheableUrl(entry.url) : null;
      if (!entry || !safeResourceId(resourceId) || !url) continue;
      const sourcePageUrl = entry.sourcePageUrl ? cacheableUrl(entry.sourcePageUrl) : null;
      output.push({
        resourceId,
        url,
        kind: entry.kind,
        ...(entry.courseId ? { courseId: entry.courseId } : {}),
        ...(entry.contentId ? { contentId: entry.contentId } : {}),
        ...(sourcePageUrl && entry.resourceKey ? { sourcePageUrl, resourceKey: entry.resourceKey } : {}),
        mimeType: entry.mimeType,
        maxBytes: entry.maxBytes,
      });
    }
    return output;
  }

  restoreCachedResources(resources: readonly ClassicCachedResource[]): ReadonlyMap<string, string> {
    this.clearStale();
    const remapped = new Map<string, string>();
    let skipped = 0;
    for (const resource of resources.slice(0, 2_000)) {
      if (!safeResourceId(resource.resourceId) || !cacheableUrl(resource.url)) { skipped += 1; continue; }
      const resourceId = this.register({
        url: resource.url,
        kind: resource.kind,
        ...(resource.courseId ? { courseId: resource.courseId } : {}),
        ...(resource.contentId ? { contentId: resource.contentId } : {}),
        ...(resource.sourcePageUrl ? { sourcePageUrl: resource.sourcePageUrl } : {}),
        ...(resource.resourceKey ? { resourceKey: resource.resourceKey } : {}),
        mimeType: resource.mimeType,
        maxBytes: resource.maxBytes,
      });
      if (resourceId) remapped.set(resource.resourceId, resourceId);
      else skipped += 1;
    }
    debugLog.event('classic.resource.cache-restore', { restoredCount: remapped.size, skippedCount: skipped, inputCount: Math.min(resources.length, 2_000) });
    return remapped;
  }

  private async sourcePageCandidates(entry: ResourceEntry, budget: { readonly signal: AbortSignal; readonly deadlineAt: number; readonly requestLimit: number; readonly responseBytesLimit: number }, traceId: TraceId | undefined): Promise<SourcePageCandidates> {
    if (!entry.sourcePageUrl) return new Map();
    this.clearStale();
    const cacheKey = `${entry.generation}:${entry.sourcePageUrl.href}`;
    const existing = this.sourcePageContexts.get(cacheKey);
    if (existing) return existing;
    const pending = (async (): Promise<SourcePageCandidates> => {
      debugLog.event('classic.resource.image-context', {
        traceId,
        courseId: entry.courseId,
        contentId: entry.contentId,
        sourceUrl: entry.sourcePageUrl!.href,
        stage: 'source-page.fetch',
        referenceCount: 1,
        matchedCount: 0,
      });
      let response: Awaited<ReturnType<ClassicApiTransport['request']>>;
      try {
        response = await this.transport.request<string>({
          method: 'GET',
          url: entry.sourcePageUrl!,
          resource: 'source-page',
          ...(entry.courseId ? { courseId: entry.courseId } : {}),
          ...(traceId ? { traceId } : {}),
          budget,
        });
      } catch (error) {
        debugLog.error('classic.resource.image-context', error, {
          traceId,
          courseId: entry.courseId,
          contentId: entry.contentId,
          sourceUrl: entry.sourcePageUrl!.href,
          stage: 'source-page.error',
          referenceCount: 1,
          matchedCount: 0,
        });
        throw error;
      }
      const contentTypeHeader = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentTypeHeader && contentTypeHeader !== 'text/html' && contentTypeHeader !== 'application/xhtml+xml') {
        debugLog.event('classic.resource.image-context', {
          traceId,
          courseId: entry.courseId,
          contentId: entry.contentId,
          sourceUrl: entry.sourcePageUrl!.href,
          stage: 'source-page.error',
          referenceCount: 1,
          matchedCount: 0,
          errorCode: 'SOURCE_PAGE_CONTENT_TYPE',
        });
        throw new ClassicApiError('RESOURCE_FAILED', 'Classic 公告来源页不是受支持的 HTML 文档。', { scope: 'classic.resource.image-context', status: 415, retryable: false });
      }
      if (typeof response.data !== 'string') {
        debugLog.event('classic.resource.image-context', {
          traceId,
          courseId: entry.courseId,
          contentId: entry.contentId,
          sourceUrl: entry.sourcePageUrl!.href,
          stage: 'source-page.error',
          referenceCount: 1,
          matchedCount: 0,
          errorCode: 'SOURCE_PAGE_NOT_TEXT',
        });
        throw new ClassicApiError('RESOURCE_FAILED', 'Classic 公告来源页没有可解析的 HTML 文本。', { scope: 'classic.resource.image-context', status: 502, retryable: false });
      }
      const candidates: SourcePageCandidates = new Map();
      for (const source of extractBbcsWebDavImageSources(response.data, entry.sourcePageUrl!)) {
        if (!source.prefixed) continue;
        const urls = new Set(candidates.get(source.key) ?? []);
        urls.add(source.url);
        candidates.set(source.key, urls);
      }
      debugLog.event('classic.resource.image-context', {
        traceId,
        courseId: entry.courseId,
        contentId: entry.contentId,
        sourceUrl: entry.sourcePageUrl!.href,
        stage: 'source-page.match',
        referenceCount: 1,
        candidateCount: [...candidates.values()].reduce((count, urls) => count + urls.size, 0),
        matchedCount: candidates.get(entry.resourceKey ?? '')?.size ?? 0,
      });
      return candidates;
    })();
    this.sourcePageContexts.set(cacheKey, pending);
    while (this.sourcePageContexts.size > MAX_SOURCE_PAGE_CONTEXTS) {
      const oldest = this.sourcePageContexts.keys().next().value;
      if (oldest === undefined || oldest === cacheKey) break;
      this.sourcePageContexts.delete(oldest);
    }
    pending.catch(() => {
      if (this.sourcePageContexts.get(cacheKey) === pending) this.sourcePageContexts.delete(cacheKey);
    });
    return pending;
  }

  private async resolveEntryUrl(entry: ResourceEntry, budget: { readonly signal: AbortSignal; readonly deadlineAt: number; readonly requestLimit: number; readonly responseBytesLimit: number }, traceId: TraceId | undefined): Promise<URL> {
    if (entry.kind !== 'image') return entry.url;
    const inspected = inspectBbcsWebDavSource(entry.url);
    if (!inspected || inspected.prefixed) return entry.url;
    if (!entry.sourcePageUrl || !entry.resourceKey) {
      debugLog.event('classic.resource.image-context', {
        traceId,
        courseId: entry.courseId,
        contentId: entry.contentId,
        sourceUrl: entry.url.href,
        stage: 'unresolved',
        referenceCount: 1,
        matchedCount: 0,
        candidateCount: 0,
        errorCode: 'IMAGE_CONTEXT_MISSING_SOURCE',
      });
      throw new ClassicApiError('RESOURCE_FAILED', 'Classic 图片缺少可验证的公告来源上下文。', { scope: 'classic.resource.image-context', status: 422, retryable: false });
    }
    const candidates = await this.sourcePageCandidates(entry, budget, traceId);
    const matches = candidates.get(entry.resourceKey) ?? new Set<string>();
    if (matches.size !== 1) {
      debugLog.event('classic.resource.image-context', {
        traceId,
        courseId: entry.courseId,
        contentId: entry.contentId,
        sourceUrl: entry.sourcePageUrl.href,
        targetUrl: entry.url.href,
        stage: matches.size > 1 ? 'ambiguous' : 'unresolved',
        referenceCount: 1,
        candidateCount: matches.size,
        matchedCount: 0,
        ...(matches.size > 1 ? { errorCode: 'IMAGE_CONTEXT_AMBIGUOUS' } : { errorCode: 'IMAGE_CONTEXT_UNRESOLVED' }),
      });
      throw new ClassicApiError('RESOURCE_FAILED', matches.size > 1 ? 'Classic 图片来源上下文不唯一。' : 'Classic 图片来源页没有匹配的资源上下文。', { scope: 'classic.resource.image-context', status: 422, retryable: false });
    }
    const resolved = new URL([...matches][0]!);
    entry.url = resolved;
    debugLog.event('classic.resource.image-context', {
      traceId,
      courseId: entry.courseId,
      contentId: entry.contentId,
      sourceUrl: entry.sourcePageUrl.href,
      targetUrl: resolved.href,
      stage: 'resolved',
      referenceCount: 1,
      candidateCount: 1,
      matchedCount: 1,
    });
    return resolved;
  }

  /**
   * Main-process media read for a typed IPC adapter. The opaque ID is the
   * only renderer input; the source URL, Cookie header and temporary redirect
   * target remain inside the authenticated transport.
   */
  async read(resourceId: string, options: ReadClassicResourceOptions = {}): Promise<ClassicResourceReadResult> {
    const entry = this.entries.get(resourceId);
    if (!safeResourceId(resourceId) || !entry) throw new ClassicApiError('NOT_FOUND', 'Classic resource 不存在。', { scope: 'classic.resource', retryable: false });
    const expectedKind = options.expectedKind ?? 'image';
    if (entry.kind !== expectedKind) throw new ClassicApiError('BAD_INPUT', 'Classic resource 类型与读取通道不匹配。', { scope: 'classic.resource.kind', retryable: false });
    if (entry.generation !== this.session.generation || this.session.state !== 'authenticated' || this.session.account?.sessionGeneration !== this.session.generation) {
      throw new ClassicApiError('AUTH_REQUIRED', 'Classic resource 会话已失效。', { scope: 'classic.resource', retryable: false });
    }
    try {
      return await this.fetchEntry(entry, options.method ?? 'GET', options.signal, options.traceId ?? entry.traceId);
    } catch (error) {
      debugLog.error('classic.resource.failed', error, { resource: 'attachments', resourceId });
      throw error;
    }
  }

  private async fetchEntry(entry: ResourceEntry, method: 'GET' | 'HEAD', signal: AbortSignal | undefined, traceId: TraceId | undefined): Promise<ClassicResourceReadResult> {
    const sourceSignal = signal ?? new AbortController().signal;
    if (sourceSignal.aborted) throw new ClassicApiError('TIMEOUT', 'Classic resource 读取已取消。', { scope: 'classic.resource', retryable: false });
    const controller = new AbortController();
    const onAbort = () => controller.abort(sourceSignal.reason);
    sourceSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('resource timeout')), 15_000);
    try {
      if (entry.generation !== this.session.generation || this.session.state !== 'authenticated' || this.session.account?.sessionGeneration !== this.session.generation) {
        throw new ClassicApiError('AUTH_REQUIRED', 'Classic resource 会话已失效。', { scope: 'classic.resource', retryable: false });
      }
      const budget = {
        signal: controller.signal,
        deadlineAt: Date.now() + 15_000,
        requestLimit: RESOURCE_REQUEST_LIMIT,
        responseBytesLimit: entry.maxBytes,
      };
      const url = await this.resolveEntryUrl(entry, budget, traceId);
      const response = await this.transport.request<Uint8Array>({
        method,
        url,
        resource: 'attachments',
        ...(entry.courseId ? { courseId: entry.courseId } : {}),
        ...(traceId ? { traceId } : {}),
        budget,
      });
      if (entry.generation !== this.session.generation) throw new ClassicApiError('AUTH_REQUIRED', 'Classic resource 会话已改变。', { scope: 'classic.resource', retryable: false });
      const body = response.data instanceof Uint8Array ? response.data : null;
      if (method === 'GET' && !body) throw new ClassicApiError('RESOURCE_FAILED', 'Classic resource 响应缺少媒体内容。', { scope: 'classic.resource', status: 502, retryable: false });
      const declaredContentType = response.headers['content-type'];
      const declaredType = declaredContentType ? contentType(declaredContentType) : null;
      // A server-declared HTML/script/unknown type must never inherit the
      // metadata MIME and become an apparently safe attachment. Only a
      // missing Content-Type may fall back to the registration metadata.
      if (declaredContentType && !declaredType) throw new ClassicApiError('RESOURCE_FAILED', 'Classic resource MIME 不在允许范围。', { scope: 'classic.resource', status: 415, retryable: false });
      const type = declaredType ?? entry.mimeType;
      if (!type || (entry.kind === 'image' && !SAFE_IMAGE_TYPES.has(type)) || (entry.mimeType && type !== entry.mimeType && type !== 'application/octet-stream' && entry.mimeType !== 'application/octet-stream')) {
        throw new ClassicApiError('RESOURCE_FAILED', 'Classic resource MIME 与注册范围不一致。', { scope: 'classic.resource', status: 415, retryable: false });
      }
      if (body && body.byteLength > entry.maxBytes) throw new ClassicApiError('RESOURCE_FAILED', 'Classic resource 超过大小限制。', { scope: 'classic.resource', status: 413, retryable: false });
      return { resourceId: entry.resourceId, status: response.status, mimeType: type, body: method === 'HEAD' ? null : body };
    } finally {
      clearTimeout(timer);
      sourceSignal.removeEventListener('abort', onAbort);
    }
  }
}

