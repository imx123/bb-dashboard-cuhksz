import { randomUUID } from 'node:crypto';
import { debugLog } from '../debug-log.js';
import { CLASSIC_API_ORIGIN, type ClassicApiTransport, type TraceId } from './api-contract.js';
import { ClassicApiError } from './api-errors.js';
import type { ClassicSession } from './session.js';

export const CLASSIC_RESOURCE_SCHEME = 'lms-resource';
const RESOURCE_HOST = 'resource';
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;
// ClassicHttpClient counts each redirect hop against requestLimit. Keep the
// attachment budget bounded while allowing its known same-origin 302 chain:
// three attempts (initial + two retries) times six hops (initial + five 302s).
const RESOURCE_REQUEST_LIMIT = 18;

const SAFE_MEDIA_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'application/pdf', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed',
  'text/plain', 'text/csv',
]);
const SAFE_IMAGE_TYPES = new Set(['image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png', 'image/webp']);

interface ResourceEntry {
  readonly resourceId: string;
  readonly url: URL;
  readonly generation: number;
  readonly kind: 'image' | 'attachment';
  readonly courseId?: string;
  readonly contentId?: string;
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

  constructor(
    private readonly session: ClassicSession,
    private readonly transport: ClassicApiTransport,
  ) {}

  register(options: RegisterClassicResourceOptions): string | null {
    this.clearStale();
    if (this.session.state !== 'authenticated' || !this.session.account || this.session.account.sessionGeneration !== this.session.generation) return null;
    const url = safeSourceUrl(options.url);
    if (!url) return null;
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
      mimeType: registeredMime,
      maxBytes: boundedBytes(options.maxBytes),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    };
    this.entries.set(resourceId, entry);
    return resourceId;
  }

  clear(): void {
    this.entries.clear();
  }

  clearStale(): void {
    const generation = this.session.generation;
    for (const [resourceId, entry] of this.entries) if (entry.generation !== generation) this.entries.delete(resourceId);
  }

  resourceUrl(resourceId: string): string | null {
    this.clearStale();
    const entry = this.entries.get(resourceId);
    if (!safeResourceId(resourceId) || !entry || entry.kind !== 'image') return null;
    return `${CLASSIC_RESOURCE_SCHEME}://${RESOURCE_HOST}/${encodeURIComponent(resourceId)}`;
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
      const response = await this.transport.request<Uint8Array>({
        method,
        url: entry.url,
        resource: 'attachments',
        ...(entry.courseId ? { courseId: entry.courseId } : {}),
        ...(traceId ? { traceId } : {}),
        budget: {
          signal: controller.signal,
          deadlineAt: Date.now() + 15_000,
          requestLimit: RESOURCE_REQUEST_LIMIT,
          responseBytesLimit: entry.maxBytes,
        },
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

