import { debugLog } from '../debug-log.js';
import {
  ClassicApiError,
  apiErrorFromStatus,
} from './api-errors.js';
import type {
  ClassicApiRequest,
  ClassicApiResponse,
  ClassicApiTransport,
  ClassicCookie,
  ClassicSession as ClassicSessionContract,
} from './api-contract.js';
import type { ClassicSession } from './session.js';

const MAX_REDIRECTS = 5;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = 150;
const MAX_CONCURRENT = 3;
const LOGIN_PATH = /\/(?:webapps\/login|auth-saml\/saml\/login|adfs\/ls|login\.jsp|oidcAuth)(?:\/|$)/i;
const AUTH_REDIRECT_PATH = /\/(?:webapps\/login|auth-saml|adfs\/ls|login(?:\.jsp)?|oidc|oauth|saml)(?:[/?#]|$)/i;
const SENSITIVE_HEADER = /^(?:set-cookie|cookie|authorization|proxy-authorization|x-.*token|x-.*auth)$/i;

type RecordValue = Record<string, unknown>;
type ManagedSession = ClassicSessionContract & {
  captureGeneration(): number;
  isGenerationCurrent(generation: number): boolean;
  registerRequest(controller: AbortController): () => void;
  markExpired?: () => void;
  isKnownAuthOrigin?: (url: URL) => boolean;
};

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deadlineError(scope: string): ClassicApiError {
  return new ClassicApiError('TIMEOUT', 'Blackboard 请求超过时间预算。', { scope });
}

function abortReason(signal: AbortSignal, scope: string): Error {
  if (signal.reason instanceof ClassicApiError) return signal.reason;
  return new ClassicApiError('TIMEOUT', 'Blackboard 请求已取消或超时。', { scope });
}

function assertUrl(request: ClassicApiRequest): URL {
  const url = request.url;
  if (url.protocol !== 'https:' || url.origin !== 'https://bb.cuhk.edu.cn' || url.username || url.password || url.port || url.hash) {
    throw new ClassicApiError('URL_REJECTED', 'Classic API 仅允许学校 HTTPS origin 的无片段 URL。', { scope: `api:${request.resource}`, retryable: false });
  }
  // API readers must carry the exact course scope. Registered opaque media
  // starts inside the same school origin but may legitimately land on a
  // bbcswebdav path that contains no course ID; its registry entry supplies
  // the course/generation authorization instead.
  if (request.courseId && request.resource !== 'attachments') {
    if (!hasCourseScope(url, request.courseId)) {
      throw new ClassicApiError('URL_REJECTED', '请求课程范围与当前 URL 不一致。', { scope: `api:${request.resource}`, retryable: false });
    }
  }
  return url;
}

function hasCourseScope(url: URL, courseId: string): boolean {
  let decodedPath = url.pathname;
  try { decodedPath = decodeURIComponent(decodedPath); } catch { /* Keep encoded segments for the fixed-origin check. */ }
  const pathMatch = decodedPath.split('/').some(segment => segment === courseId);
  const queryMatch = [...url.searchParams.entries()].some(([key, value]) =>
    /^(?:course[_-]?id|course)$/.test(key.toLowerCase()) && value === courseId,
  );
  return pathMatch || queryMatch;
}

function headersRecord(headers: Headers): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (SENSITIVE_HEADER.test(key)) return;
    if (['content-type', 'content-length', 'etag', 'last-modified', 'retry-after', 'cache-control'].includes(key.toLowerCase())) output[key.toLowerCase()] = value.slice(0, 512);
  });
  return output;
}

function setCookieHeaders(headers: Headers): string[] {
  const maybe = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof maybe.getSetCookie === 'function' ? maybe.getSetCookie() : [];
  if (values.length) return values.slice(0, 50).map(value => value.slice(0, 32_768));
  const combined = headers.get('set-cookie');
  if (!combined) return [];
  const result: string[] = [];
  let start = 0;
  let expires = false;
  for (let index = 0; index < combined.length; index += 1) {
    const char = combined[index];
    if (char === ';') expires = false;
    else if (char === '=' && /expires$/i.test(combined.slice(Math.max(start, index - 8), index).trim())) expires = true;
    else if (char === ',' && !expires && /^\s*[^;,=\s]+\s*=/.test(combined.slice(index + 1))) {
      const value = combined.slice(start, index).trim();
      if (value) result.push(value);
      start = index + 1;
    }
  }
  const value = combined.slice(start).trim();
  if (value) result.push(value);
  return result.slice(0, 50).map(item => item.slice(0, 32_768));
}

function retryAfterMs(value: string | undefined): number {
  if (!value) return 400;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(5_000, Math.max(0, date - Date.now())) : 400;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const finish = () => { cleanup(); resolve(); };
    const abort = () => {
      if (timer !== undefined) clearTimeout(timer);
      cleanup();
      reject(abortReason(signal, 'api.scheduler'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(finish, ms);
  });
}

type ScheduledJob<T> = { signal: AbortSignal; run: () => Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

class RequestScheduler {
  private running = 0;
  private lastStart = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: ScheduledJob<unknown>[] = [];

  run<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ signal, run, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this.timer || this.running >= MAX_CONCURRENT || this.queue.length === 0) return;
    const job = this.queue.shift()!;
    if (job.signal.aborted) { job.reject(abortReason(job.signal, 'api.scheduler')); this.pump(); return; }
    const delay = Math.max(0, this.lastStart + MIN_INTERVAL_MS - Date.now());
    if (delay > 0) {
      this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, delay);
      this.queue.unshift(job);
      return;
    }
    this.running += 1;
    this.lastStart = Date.now();
    void job.run().then(job.resolve, job.reject).finally(() => {
      this.running -= 1;
      this.pump();
    });
    this.pump();
  }
}

const scheduler = new RequestScheduler();
const budgetCounts = new WeakMap<object, number>();

function consumeBudget(request: ClassicApiRequest): void {
  const budget = request.budget;
  const now = Date.now();
  const reserveMs = budget.reserveMs ?? 0;
  if (now >= budget.deadlineAt || (!request.allowReservedBudget && reserveMs > 0 && now >= budget.deadlineAt - reserveMs)) {
    if (!request.allowReservedBudget && reserveMs > 0 && now < budget.deadlineAt) {
      throw new ClassicApiError('PARTIAL_RESULTS', 'Blackboard 业务请求为最终身份复核保留了时间预算。', { scope: `api:${request.resource}`, retryable: false });
    }
    throw deadlineError(`api:${request.resource}`);
  }
  const count = (budgetCounts.get(budget) ?? 0) + 1;
  const reserveRequests = request.allowReservedBudget ? 0 : (budget.reserveRequests ?? 0);
  if (count > budget.requestLimit - reserveRequests) throw new ClassicApiError('PARTIAL_RESULTS', 'Blackboard 请求达到本次范围预算。', { scope: `api:${request.resource}`, retryable: false });
  if (request.allowReservedBudget && count > budget.requestLimit) throw new ClassicApiError('PARTIAL_RESULTS', 'Blackboard 请求达到本次范围预算。', { scope: `api:${request.resource}`, retryable: false });
  budgetCounts.set(budget, count);
}

function effectiveDeadlineAt(request: ClassicApiRequest): number {
  const reserveMs = request.budget.reserveMs ?? 0;
  return request.allowReservedBudget ? request.budget.deadlineAt : Math.max(0, request.budget.deadlineAt - reserveMs);
}

async function readBody(response: Response, controller: AbortController, maxBytes: number, signal: AbortSignal, scope: string, generationCheck?: () => void): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let completed = false;
  try {
    while (true) {
      generationCheck?.();
      if (signal.aborted) throw abortReason(signal, scope);
      let remaining: ReadableStreamReadResult<Uint8Array>;
      try {
        remaining = await reader.read();
      } catch (error) {
        generationCheck?.();
        if (signal.aborted) throw abortReason(signal, scope);
        if (controller.signal.aborted) throw deadlineError(scope);
        throw new ClassicApiError('NETWORK', 'Blackboard 响应读取失败。', { scope, retryable: true, cause: error });
      }
      if (remaining.done) { completed = true; break; }
      const chunk = remaining.value;
      size += chunk.byteLength;
      if (size > maxBytes) {
        controller.abort(new Error('Classic response exceeds its bounded size.'));
        throw new ClassicApiError('RESOURCE_FAILED', 'Blackboard 响应超过大小限制。', { scope, retryable: false });
      }
      chunks.push(chunk);
    }
    generationCheck?.();
    if (controller.signal.aborted && !signal.aborted) throw deadlineError(scope);
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* Cleanup cannot mask the original error. */ }
    }
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** Release an unconsumed response stream before returning a status/redirect error. */
async function discardResponse(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* Cleanup cannot mask the original error. */ }
}

function looksLikeLoginHtml(body: Uint8Array, contentType: string | null, url: URL): boolean {
  if (LOGIN_PATH.test(url.pathname)) return true;
  if (!contentType?.toLowerCase().includes('text/html')) return false;
  const text = new TextDecoder().decode(body.slice(0, 64_000));
  const hasPasswordControl = /<input\b[^>]*(?:type\s*=\s*["']?password\b|name\s*=\s*["'][^"']*pass(?:word)?)/i.test(text);
  const loginForm = /<form\b[^>]*(?:action\s*=\s*["'][^"']*(?:login|saml|oidc|auth)|id\s*=\s*["'][^"']*(?:login|saml|auth))/i.test(text);
  const loginTitle = /<title\b[^>]*>[^<]*(?:sign[ -]?in|log[ -]?in|登录|单点登录)/i.test(text);
  return (hasPasswordControl && /<form\b/i.test(text)) || loginForm || loginTitle;
}

function decodeBody(body: Uint8Array, contentType: string | null, request: ClassicApiRequest): unknown {
  if (body.byteLength === 0) return null;
  const type = contentType?.toLowerCase() ?? '';
  if (type.includes('application/json') || type.includes('+json')) {
    try { return JSON.parse(new TextDecoder().decode(body)) as unknown; }
    catch { throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard JSON 响应无法解析。', { scope: `api:${request.resource}`, retryable: false }); }
  }
  if (request.resource === 'attachments' && (/^(?:image|audio|video)\//i.test(type) || /^application\/(?:pdf|octet-stream|zip)$/i.test(type))) return body;
  if (type.startsWith('text/')) return new TextDecoder().decode(body);
  return body;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ClassicApiError && error.retryable && ['RATE_LIMITED', 'TIMEOUT', 'NETWORK'].includes(error.code);
}

function ensureGeneration(session: ManagedSession, generation: number, resource: string): void {
  if (!session.isGenerationCurrent(generation)) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话已改变，请重新读取。', { scope: `api:${resource}`, retryable: false });
}

function markSessionExpired(session: ManagedSession): void {
  try { session.markExpired?.(); } catch { /* Expiry state is advisory to the current error. */ }
}

/** Fixed-origin, GET/HEAD-only transport shared by API readers and resources. */
export class ClassicHttpClient implements ClassicApiTransport {
  constructor(private readonly session: ClassicSessionContract) {}

  async request<T = unknown>(request: ClassicApiRequest): Promise<ClassicApiResponse<T>> {
    const url = assertUrl(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new ClassicApiError('BAD_INPUT', 'Classic HTTP 只允许 GET/HEAD。', { scope: `api:${request.resource}`, retryable: false });
    const session = this.session as ManagedSession;
    const generation = session.captureGeneration();
    let last: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        debugLog.event('classic.api.http.start', { traceId: request.traceId, resource: request.resource, targetUrl: url.href, attempt, courseId: request.courseId });
        ensureGeneration(session, generation, request.resource);
        const result = await scheduler.run(request.budget.signal, () => this.perform(request, url, generation, attempt));
        ensureGeneration(session, generation, request.resource);
        return result as ClassicApiResponse<T>;
      } catch (error) {
        last = error;
        if (request.budget.signal.aborted) {
          debugLog.error('classic.api.http.failure', error, { traceId: request.traceId, resource: request.resource, targetUrl: url.href, landingUrl: url.href, attempt, courseId: request.courseId });
          throw abortReason(request.budget.signal, `api:${request.resource}`);
        }
        if (!isRetryable(error) || attempt >= MAX_RETRIES) throw error;
        const delay = error instanceof ClassicApiError && error.code === 'RATE_LIMITED'
          ? retryAfterMs((error as ClassicApiError & { readonly retryAfterMs?: string }).retryAfterMs)
          : Math.min(5_000, 400 * 2 ** attempt);
        debugLog.error('classic.api.http.retry', error, { traceId: request.traceId, resource: request.resource, targetUrl: url.href, attempt, delayMs: delay, courseId: request.courseId });
        await sleep(delay, request.budget.signal);
      }
    }
    throw last instanceof Error ? last : new ClassicApiError('NETWORK', 'Blackboard 请求失败。', { scope: `api:${request.resource}` });
  }

  private async perform(request: ClassicApiRequest, initial: URL, generation: number, attempt: number): Promise<ClassicApiResponse<unknown>> {
    const session = this.session as ManagedSession;
    const controller = new AbortController();
    const signal = request.budget.signal;
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    const unregister = session.registerRequest(controller);
    const timeout = setTimeout(() => controller.abort(new Error('Classic request timeout.')), Math.max(1, Math.min(REQUEST_TIMEOUT_MS, effectiveDeadlineAt(request) - Date.now())));
    let current = initial;
    let redirects = 0;
    try {
      while (true) {
        ensureGeneration(session, generation, request.resource);
        consumeBudget(request);
        let cookies: readonly ClassicCookie[];
        try { cookies = await session.cookiesFor(current, signal); }
        catch (error) { throw error; }
        ensureGeneration(session, generation, request.resource);
        const cookieHeader = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        let response: Response;
        try {
          response = await fetch(current, {
            method: request.method,
            redirect: 'manual',
            headers: {
              Accept: 'application/json, text/plain, image/*, application/octet-stream',
              'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            signal: controller.signal,
          });
        } catch (error) {
          if (signal.aborted) throw abortReason(signal, `api:${request.resource}`);
          ensureGeneration(session, generation, request.resource);
          if (Date.now() >= effectiveDeadlineAt(request) || controller.signal.aborted) throw deadlineError(`api:${request.resource}`);
          throw new ClassicApiError('NETWORK', 'Blackboard 网络请求失败。', { scope: `api:${request.resource}`, retryable: true, cause: error });
        }
        ensureGeneration(session, generation, request.resource);
        const responseSetCookies = setCookieHeaders(response.headers);
        await session.applySetCookie(current, responseSetCookies, signal);
        ensureGeneration(session, generation, request.resource);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            await discardResponse(response);
            throw new ClassicApiError('RESOURCE_FAILED', 'Blackboard 重定向缺少目标。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
          }
          let next: URL;
          try { next = new URL(location, current); } catch {
            await discardResponse(response);
            throw new ClassicApiError('URL_REJECTED', 'Blackboard 重定向目标无效。', { scope: `api:${request.resource}`, retryable: false });
          }
          if (next.username || next.password || next.port || next.hash || next.protocol !== 'https:') {
            await discardResponse(response);
            throw new ClassicApiError('URL_REJECTED', 'Blackboard 重定向目标不符合 HTTPS URL 边界。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
          }
          if (next.origin !== 'https://bb.cuhk.edu.cn') {
            const isKnownAuth = session.isKnownAuthOrigin?.(next) === true && AUTH_REDIRECT_PATH.test(next.pathname);
            const code = isKnownAuth ? 'SESSION_EXPIRED' : 'URL_REJECTED';
            await discardResponse(response);
            if (code === 'SESSION_EXPIRED') markSessionExpired(session);
            throw new ClassicApiError(code, code === 'SESSION_EXPIRED' ? 'Blackboard 请求进入已知认证重定向。' : 'Blackboard 资源重定向超出固定学校 origin。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
          }
          if (LOGIN_PATH.test(next.pathname)) {
            await discardResponse(response);
            markSessionExpired(session);
            throw new ClassicApiError('SESSION_EXPIRED', 'Blackboard 会话已进入登录流程。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
          }
          if (request.courseId && request.resource !== 'attachments' && !hasCourseScope(next, request.courseId)) {
            await discardResponse(response);
            throw new ClassicApiError('URL_REJECTED', 'Blackboard 重定向超出当前课程范围。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
          }
          if (++redirects > MAX_REDIRECTS) {
            await discardResponse(response);
            throw new ClassicApiError('RESOURCE_FAILED', 'Blackboard 重定向次数超过限制。', { scope: `api:${request.resource}`, retryable: false });
          }
          ensureGeneration(session, generation, request.resource);
          debugLog.event('classic.api.http.redirect', { traceId: request.traceId, resource: request.resource, targetUrl: initial.href, fromUrl: current.href, toUrl: next.href, status: response.status, redirect: redirects, attempt, courseId: request.courseId });
          current = next;
          continue;
        }
        if (response.status === 401) {
          await discardResponse(response);
          markSessionExpired(session);
          throw new ClassicApiError('SESSION_EXPIRED', 'Blackboard 会话已过期，请重新登录。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
        }
        if (response.status === 403) {
          await discardResponse(response);
          throw apiErrorFromStatus(response.status, `api:${request.resource}`, current);
        }
        if (response.status === 404) {
          await discardResponse(response);
          throw apiErrorFromStatus(response.status, `api:${request.resource}`, current);
        }
        if (response.status === 429) {
          const rateLimited = apiErrorFromStatus(response.status, `api:${request.resource}`, current);
          (rateLimited as ClassicApiError & { retryAfterMs?: string }).retryAfterMs = response.headers.get('retry-after') ?? undefined;
          await discardResponse(response);
          throw rateLimited;
        }
        if (!response.ok) {
          await discardResponse(response);
          throw apiErrorFromStatus(response.status, `api:${request.resource}`, current);
        }
        if (request.method === 'HEAD') {
          await discardResponse(response);
          ensureGeneration(session, generation, request.resource);
          debugLog.event('classic.api.http.response', { traceId: request.traceId, resource: request.resource, status: response.status, bytes: 0, targetUrl: initial.href, landingUrl: current.href, redirects, attempt, courseId: request.courseId });
          return { status: response.status, url: current, headers: headersRecord(response.headers), data: null, bytes: 0 };
        }
        let body: Uint8Array;
        try {
          body = await readBody(response, controller, request.budget.responseBytesLimit, signal, `api:${request.resource}`, () => ensureGeneration(session, generation, request.resource));
        } catch (error) {
          if (error instanceof ClassicApiError) throw error;
          ensureGeneration(session, generation, request.resource);
          if (signal.aborted) throw abortReason(signal, `api:${request.resource}`);
          if (Date.now() >= effectiveDeadlineAt(request) || controller.signal.aborted) throw deadlineError(`api:${request.resource}`);
          throw new ClassicApiError('NETWORK', 'Blackboard 响应读取失败。', { scope: `api:${request.resource}`, retryable: true, cause: error });
        }
        ensureGeneration(session, generation, request.resource);
        const contentType = response.headers.get('content-type');
        if (looksLikeLoginHtml(body, contentType, current)) {
          markSessionExpired(session);
          throw new ClassicApiError('SESSION_EXPIRED', 'Blackboard 返回登录页面而不是数据。', { scope: `api:${request.resource}`, status: response.status, retryable: false });
        }
        const data = decodeBody(body, contentType, request);
        ensureGeneration(session, generation, request.resource);
        debugLog.event('classic.api.http.response', { traceId: request.traceId, resource: request.resource, status: response.status, bytes: body.byteLength, targetUrl: initial.href, landingUrl: current.href, redirects, attempt, courseId: request.courseId });
        ensureGeneration(session, generation, request.resource);
        return { status: response.status, url: current, headers: headersRecord(response.headers), data, bytes: body.byteLength };
      }
    } catch (error) {
      debugLog.error('classic.api.http.failure', error, { traceId: request.traceId, resource: request.resource, targetUrl: initial.href, landingUrl: current.href, redirects, attempt, courseId: request.courseId });
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      unregister();
    }
  }
}

export { MIN_INTERVAL_MS, MAX_CONCURRENT, MAX_REDIRECTS, REQUEST_TIMEOUT_MS };

